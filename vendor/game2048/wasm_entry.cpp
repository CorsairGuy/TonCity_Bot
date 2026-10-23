// Обёртка для WASM-сборки (vendor/game2048/build.sh): тот же поиск, что find_best_move в 2048.cpp,
// только без вывода в консоль и с экспортом best_move(board) -> 0..3 (up,down,left,right) или -1.

#define main cli_main
#define HAVE_UNORDERED_MAP 1
#include "2048.cpp"
#undef main

static bool tables_ready = false;

extern "C" __attribute__((export_name("best_move")))
int best_move(board_t board) {
    if (!tables_ready) { init_tables(); tables_ready = true; }
    float best = 0;
    int bestmove = -1;
    for (int move = 0; move < 4; move++) {
        eval_state state;
        state.depth_limit = std::max(3, count_distinct_tiles(board) - 2);
        float res = _score_toplevel_move(state, board, move);
        if (res > best) { best = res; bestmove = move; }
    }
    return bestmove;
}

// без исключений: свои new/delete поверх malloc (libc++ из wasi тянет __cxa_throw ради bad_alloc)
void* operator new(size_t n) { void* p = malloc(n ? n : 1); if (!p) abort(); return p; }
void* operator new[](size_t n) { return operator new(n); }
void operator delete(void* p) noexcept { free(p); }
void operator delete[](void* p) noexcept { free(p); }
void operator delete(void* p, size_t) noexcept { free(p); }
void operator delete[](void* p, size_t) noexcept { free(p); }
