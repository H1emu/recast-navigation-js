import assert from 'node:assert/strict';
import {
  closeSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const options = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const separator = arg.indexOf('=');
      return separator === -1
        ? [arg.slice(2), 'true']
        : [arg.slice(2, separator), arg.slice(separator + 1)];
    }),
);

const [corePath, wasmPath, cacheDirectory] = positional;
assert.ok(corePath, 'missing core module path');
assert.ok(wasmPath, 'missing generated WASM module path');
assert.ok(cacheDirectory, 'missing split TSET directory');

const limitOption = options.get('limit');
const requestedLimit = limitOption
  ? Number(limitOption)
  : Number.POSITIVE_INFINITY;
const progressEvery = Number(options.get('progress') ?? 5000);
const reportPath = options.get('report');

assert.ok(
  Number.isInteger(requestedLimit) ||
    requestedLimit === Number.POSITIVE_INFINITY,
  'limit must be an integer',
);
assert.ok(requestedLimit > 0, 'limit must be positive');
assert.ok(
  Number.isInteger(progressEvery) && progressEvery > 0,
  'invalid progress',
);

const core = await import(pathToFileURL(resolve(corePath)));
const { default: createRecast } = await import(
  pathToFileURL(resolve(wasmPath))
);
await core.init(createRecast);

assert.equal(
  core.uses64BitPolyRefs(),
  true,
  'monolithic test requires a DT_POLYREF64 WASM build',
);

const partNames = readdirSync(cacheDirectory)
  .filter((name) => /^z1_cache_\d+\.bin$/.test(name))
  .sort(
    (left, right) =>
      Number(left.match(/\d+/)[0]) - Number(right.match(/\d+/)[0]),
  );

assert.ok(partNames.length > 0, `no z1_cache_*.bin files in ${cacheDirectory}`);

let storeLength = 0;
const parts = partNames.map((name) => {
  const path = resolve(cacheDirectory, name);
  const length = statSync(path).size;
  const part = {
    fd: openSync(path, 'r'),
    length,
    name,
    start: storeLength,
  };
  storeLength += length;
  return part;
});

const readRange = (offset, length) => {
  if (offset < 0 || length < 0 || offset + length > storeLength) {
    throw new Error(`TSET range ${offset}+${length} exceeds ${storeLength}`);
  }

  const result = Buffer.allocUnsafe(length);
  let outputOffset = 0;
  let position = offset;

  while (outputOffset < length) {
    const part = parts.find(
      (candidate) =>
        position >= candidate.start &&
        position < candidate.start + candidate.length,
    );
    if (!part) throw new Error(`no TSET part contains offset ${position}`);

    const partOffset = position - part.start;
    const readLength = Math.min(
      length - outputOffset,
      part.length - partOffset,
    );
    const bytesRead = readSync(
      part.fd,
      result,
      outputOffset,
      readLength,
      partOffset,
    );
    if (bytesRead !== readLength) {
      throw new Error(`short read from ${part.name} at ${partOffset}`);
    }

    outputOffset += bytesRead;
    position += bytesRead;
  }

  return result;
};

const nextPowerOfTwo = (value) => {
  let result = 1;
  while (result < value) result *= 2;
  return result;
};

const memorySnapshot = () => ({
  heapUsedMiB: Number((process.memoryUsage().heapUsed / 1048576).toFixed(1)),
  rssMiB: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
  wasmHeapMiB: Number((core.Raw.Module.HEAPU8.byteLength / 1048576).toFixed(1)),
});

const header = readRange(0, 92);
const TSET_MAGIC =
  ('T'.charCodeAt(0) << 24) |
  ('S'.charCodeAt(0) << 16) |
  ('E'.charCodeAt(0) << 8) |
  'T'.charCodeAt(0);

assert.equal(header.readInt32LE(0), TSET_MAGIC, 'invalid TSET magic');
assert.equal(header.readInt32LE(4), 1, 'unsupported TSET version');

const numTiles = header.readInt32LE(8);
assert.ok(numTiles > 0, 'TSET contains no compressed layers');

const generatedMesh = {
  orig: {
    x: header.readFloatLE(12),
    y: header.readFloatLE(16),
    z: header.readFloatLE(20),
  },
  tileWidth: header.readFloatLE(24),
  tileHeight: header.readFloatLE(28),
  maxTiles: header.readInt32LE(32),
  maxPolys: header.readInt32LE(36),
};
const generatedCache = {
  orig: [
    header.readFloatLE(40),
    header.readFloatLE(44),
    header.readFloatLE(48),
  ],
  cs: header.readFloatLE(52),
  ch: header.readFloatLE(56),
  width: header.readInt32LE(60),
  height: header.readInt32LE(64),
  walkableHeight: header.readFloatLE(68),
  walkableRadius: header.readFloatLE(72),
  walkableClimb: header.readFloatLE(76),
  maxSimplificationError: header.readFloatLE(80),
  maxTiles: header.readInt32LE(84),
  maxObstacles: header.readInt32LE(88),
};

const runtimeMaxTiles = nextPowerOfTwo(numTiles);
const runtimeMesh = {
  ...generatedMesh,
  maxTiles: runtimeMaxTiles,
  maxPolys: 1 << 20,
};
const runtimeCache = {
  ...generatedCache,
  maxTiles: runtimeMaxTiles,
};
const layerLimit = Math.min(numTiles, requestedLimit);
const startedAt = performance.now();

const meshProcess = new core.TileCacheMeshProcess((params, areas, flags) => {
  for (let index = 0; index < params.polyCount(); index++) {
    areas.set(index, 0);
    flags.set(index, 1);
  }
});
// The 64-bit build enables Emscripten WASM_BIGINT so WebIDL's
// unsigned-long-long allocator capacity crosses the boundary as a bigint.
const allocator = new core.Raw.RecastLinearAllocator(1n << 20n);
const compressor = new core.Raw.RecastFastLZCompressor();
const tileCacheParams = core.DetourTileCacheParams.create(runtimeCache);
const tileCache = new core.TileCache();
assert.equal(
  tileCache.init(tileCacheParams, allocator, compressor, meshProcess),
  true,
  'failed to initialize monolithic TileCache',
);

const navMeshParams = core.NavMeshParams.create(runtimeMesh);
const navMesh = new core.NavMesh();
assert.equal(
  navMesh.initTiled(navMeshParams),
  true,
  'failed to initialize monolithic 64-bit NavMesh',
);

let cursor = 92;
let added = 0;
let built = 0;
let compressedBytes = 0;
const addFailures = [];
const buildFailures = [];
const columns = new Set();

for (let index = 0; index < layerLimit; index++) {
  const entry = readRange(cursor, 28);
  const dataSize = entry.readInt32LE(4);
  const tx = entry.readInt32LE(16);
  const ty = entry.readInt32LE(20);

  if (dataSize < 20 || cursor + 8 + dataSize > storeLength) {
    throw new Error(`invalid layer ${index} size ${dataSize} at ${cursor}`);
  }

  const compressed = readRange(cursor + 8, dataSize);
  const data = new core.UnsignedCharArray();
  data.copy(compressed);
  const addResult = tileCache.addTileCopy(data);
  data.destroy();

  if (!core.statusSucceed(addResult.status)) {
    addFailures.push({
      index,
      status: addResult.status >>> 0,
      readable: core.statusToReadableString(addResult.status),
      tx,
      ty,
    });
  } else {
    added++;
  }

  columns.add(`${tx},${ty}`);
  compressedBytes += dataSize;
  cursor += 8 + dataSize;

  if ((index + 1) % progressEvery === 0 || index + 1 === layerLimit) {
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    console.log(
      `[monolithic64] ${index + 1}/${layerLimit} layers ` +
        `added=${added} addFailures=${addFailures.length} ` +
        `elapsed=${elapsedSeconds.toFixed(1)}s ` +
        `wasm=${memorySnapshot().wasmHeapMiB}MiB`,
    );
  }
}

// Materialize by column only after every compressed layer has been installed.
// The WebIDL surface for buildNavMeshTile models dtCompressedTileRef as an
// opaque pointer wrapper, while addTile returns its numeric value. Building by
// (tx, ty) also avoids repeatedly rebuilding the same multi-layer column.
const columnList = [...columns].map((key) => key.split(',').map(Number));
for (let index = 0; index < columnList.length; index++) {
  const [tx, ty] = columnList[index];
  const buildStatus = tileCache.buildNavMeshTilesAt(tx, ty, navMesh);
  if (!core.statusSucceed(buildStatus)) {
    buildFailures.push({
      index,
      status: buildStatus >>> 0,
      readable: core.statusToReadableString(buildStatus),
      tx,
      ty,
    });
  } else {
    built++;
  }

  if ((index + 1) % progressEvery === 0 || index + 1 === columnList.length) {
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    console.log(
      `[monolithic64] ${index + 1}/${columnList.length} columns ` +
        `built=${built} buildFailures=${buildFailures.length} ` +
        `elapsed=${elapsedSeconds.toFixed(1)}s ` +
        `wasm=${memorySnapshot().wasmHeapMiB}MiB`,
    );
  }
}

let occupiedNavTiles = 0;
let navPolygons = 0;
for (let index = 0; index < navMesh.getMaxTiles(); index++) {
  const tile = navMesh.getTile(index);
  const tileHeader = tile.header();
  if (!tileHeader) continue;
  occupiedNavTiles++;
  navPolygons += tileHeader.polyCount();
}

const probes = [];
if (layerLimit === numTiles) {
  const query = new core.NavMeshQuery(navMesh, { maxNodes: 8192 });
  const locations = [
    ['pleasant-valley-pd', { x: -222, y: 23, z: -1133 }],
    ['military-base', { x: 800, y: 20, z: -2700 }],
    ['hospital', { x: 1860, y: 94, z: -2800 }],
  ];
  for (const [name, position] of locations) {
    const result = query.findNearestPoly(position, {
      halfExtents: { x: 25, y: 25, z: 25 },
    });
    probes.push({
      name,
      success: result.success,
      refType: typeof result.nearestRef,
      nearestPoint: result.nearestPoint,
      status: result.status >>> 0,
    });
  }
  query.destroy();
}

const report = {
  mode: 'DT_POLYREF64-monolithic-TSET',
  cacheDirectory: resolve(cacheDirectory),
  parts: partNames.length,
  storeBytes: storeLength,
  numTiles,
  processedLayers: layerLimit,
  complete: layerLimit === numTiles,
  generatedMesh,
  generatedCache,
  runtimeMesh,
  runtimeCache,
  columns: columns.size,
  compressedBytes,
  added,
  built,
  occupiedNavTiles,
  navPolygons,
  addFailures,
  buildFailures,
  probes,
  elapsedSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(3)),
  memory: memorySnapshot(),
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (reportPath) writeFileSync(resolve(reportPath), serialized);
process.stdout.write(
  `${JSON.stringify(
    {
      ...report,
      addFailures: addFailures.slice(0, 20),
      buildFailures: buildFailures.slice(0, 20),
      reportPath: reportPath ? resolve(reportPath) : null,
    },
    null,
    2,
  )}\n`,
);

navMesh.destroy();
tileCache.destroy();
core.Raw.destroy(navMeshParams.raw);
core.Raw.destroy(tileCacheParams.raw);
core.Raw.destroy(allocator);
core.Raw.destroy(compressor);
core.Raw.destroy(meshProcess.raw);
for (const part of parts) closeSync(part.fd);

if (addFailures.length || buildFailures.length) process.exitCode = 2;
