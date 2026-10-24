#!/bin/sh
# Сборка алгоритма 2048 в WASM для бота: src/modules/game2048.wasm. 2048.cpp/2048.h/platdefs.h/
# config.h — nneonneo/2048-ai (https://github.com/nneonneo/2048-ai, © Robert Xiao, MIT, см. LICENSE
# рядом); изменение одно — в 2048.cpp ветка FAST_TRANS_TABLE подключает нашу таблицу fast_table.h; wasm_entry.cpp — наша обёртка. Готовый .wasm лежит в git, при сборке образа ничего
# не компилируется. Нужно: clang 18 + пакеты wasi-libc, libc++-18-dev-wasm32,
# libc++abi-18-dev-wasm32, libclang-rt-18-dev-wasm32 (Ubuntu 24.04).
set -e
cd "$(dirname "$0")"
clang++ --target=wasm32-wasi --sysroot=/usr -O3 -fno-exceptions -mexec-model=reactor -std=c++17 \
  -I/usr/include/wasm32-wasi/c++/v1 wasm_entry.cpp -o ../../src/modules/game2048.wasm \
  -Wl,--strip-all -Wl,--gc-sections
