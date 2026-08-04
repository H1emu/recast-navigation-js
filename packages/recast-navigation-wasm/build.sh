#!/bin/sh

# sh build.sh [release|debug]

if [ -z $1 ] 
then
	BUILD_TYPE=release
else
	BUILD_TYPE=$1
	shift
fi

# create directories
mkdir -p ./build
mkdir -p dist

# clone recast navigation library
RECASTNAVIGATION_URL=https://github.com/xsploit/recastnavigation.git
RECASTNAVIGATION_REV=875f4a95e9ed38f515d4d228a49fa495d83c784f
[ ! -d "recastnavigation" ] && git clone --no-checkout "$RECASTNAVIGATION_URL" recastnavigation
(cd recastnavigation &&
  git fetch --depth 1 "$RECASTNAVIGATION_URL" "$RECASTNAVIGATION_REV" &&
  git checkout --detach FETCH_HEAD)

# emscripten builds
emcmake cmake -B build -DCMAKE_BUILD_TYPE=$BUILD_TYPE
cmake --build build

# generate typescript definitions
yarn run webidl-dts-gen -e -d -i build/recast-navigation.idl -o ./dist/recast-navigation.d.ts -n Recast

# copy files to dist
cp ./build/recast-navigation.* ./dist/
