#!/bin/sh
# nneonneo/2048-ai (© Robert Xiao, MIT; LICENSE рядом), наша таблица fast_table.h
# и обёртка wasm_entry.cpp. Готовый WASM хранится в git; Docker его НЕ компилирует.
# Разработка: WASI SDK 22 (clang 18.1.2) через WASI_SDK_PATH, либо системный clang 18
# с wasi-libc, libc++-18-dev-wasm32, libc++abi-18-dev-wasm32,
# libclang-rt-18-dev-wasm32 (Ubuntu 24.04).
# build.sh [output.wasm]; GAME2048_DIAGNOSTICS=1 — отдельная сборка для теста оценок.
set -eu
if [ "$#" -gt 1 ]; then
  echo "Usage: $0 [output.wasm]" >&2
  exit 1
fi
if [ "$#" -eq 1 ]; then
  case "$1" in
    /*) output=$1 ;;
    *) output="$PWD/$1" ;;
  esac
else
  output="$(dirname "$0")/../../src/modules/game2048.wasm"
  output="$(cd "$(dirname "$output")" && pwd)/$(basename "$output")"
fi
if [ "${GAME2048_DIAGNOSTICS:-0}" = 1 ]; then
  set -- -DGAME2048_DIAGNOSTICS
else
  set --
fi
cd "$(dirname "$0")"
if [ -n "${WASI_SDK_PATH:-}" ]; then
  compiler="$WASI_SDK_PATH/bin/clang++"
else
  compiler=clang++
  set -- "$@" --sysroot=/usr -I/usr/include/wasm32-wasi/c++/v1
fi
"$compiler" --target=wasm32-wasi -O3 -fno-exceptions -mexec-model=reactor -std=c++17 \
  "$@" wasm_entry.cpp -o "$output" -Wl,--strip-all -Wl,--gc-sections
