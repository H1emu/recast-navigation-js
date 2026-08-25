# DT_POLYREF64 WASM spike

This package has an opt-in `RECASTNAVIGATION_DT_POLYREF64` CMake build mode.
The default remains the existing 32-bit Detour ABI.

The 64-bit mode:

- compiles Detour, DetourCrowd, TileCache, the wrapper library, and generated
  WebIDL glue with `DT_POLYREF64`;
- enables Emscripten `WASM_BIGINT`;
- exposes polygon and navmesh tile refs as JavaScript `bigint` values;
- uses 64-bit ref wrappers for query result arrays and out parameters; and
- runs the same ABI smoke test as the 32-bit build, including exact values
  above `2^53` and the full unsigned 64-bit bit pattern.

WebIDL currently exposes high-bit unsigned values as signed JavaScript
`bigint` values. Callers must normalize at the boundary:

```js
const unsignedRef = BigInt.asUintN(64, wasmRef);
const wasmArgument = BigInt.asIntN(64, unsignedRef);
```

This remains opt-in experimental work rather than a production package:

- the TypeScript core uses a `PolyRef` (`number | bigint`) boundary and keeps
  the existing 32-bit `number` behavior for the default build;
- upstream `webidl-dts-gen` cannot parse `unsigned long long[]`, so the
  64-bit build supplies the checked wrapper/declaration surface used by the
  core instead of publishing the raw generated types as a normal release;
- the H1Emu experiment consumes compressed `TSET` data to materialize a
  complete monolithic navmesh; direct `MSET` serialization has a distinct
  version for 64-bit tile refs; and
- wider refs solve reference-capacity pressure, not malformed compressed
  layers or disconnected source topology. Those failures must still be
  repaired in the bake/extraction pipeline.

Build and test both modes from an Emscripten environment:

```sh
emcmake cmake -S . -B build-polyref32 -DCMAKE_BUILD_TYPE=release
cmake --build build-polyref32 --parallel
ctest --test-dir build-polyref32 --output-on-failure

emcmake cmake -S . -B build-polyref64 -DCMAKE_BUILD_TYPE=release \
  -DRECASTNAVIGATION_DT_POLYREF64=ON
cmake --build build-polyref64 --parallel
ctest --test-dir build-polyref64 --output-on-failure
```
