// Быстрая таблица транспозиций для WASM-сборки бота (не из оригинального 2048-ai): замена
// std::unordered_map<board_t, trans_table_entry_t> с тем же поведением — запись по ключу не
// вытесняется, повторная запись перезаписывает, поэтому поиск даёт те же оценки и те же ходы.
// Отличие только в памяти: один массив с открытой адресацией (линейное пробирование) вместо
// выделения на каждую запись. Массив общий для всех eval_state и не освобождается: новый
// eval_state «очищает» его сменой поколения (gen), без memset. Заполнилась наполовину — массив
// удваивается. Рассчитано на один поток (WASM-модуль однопоточный).
#pragma once
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

struct fast_trans_slot {
    board_t first;
    trans_table_entry_t second;
    uint32_t gen;
};

class fast_trans_table {
    static fast_trans_slot* slots;
    static size_t cap;      // степень двойки
    static size_t used;     // занято в текущем поколении
    static uint32_t gen;    // текущее поколение; 0 — «пусто»

    static size_t slot_of(board_t key, size_t mask) {
        return (size_t)((key * 0x9E3779B97F4A7C15ULL) >> 32) & mask;
    }
    static void grow() {
        size_t ncap = cap ? cap * 2 : (1u << 16);
        fast_trans_slot* ns = (fast_trans_slot*)calloc(ncap, sizeof(fast_trans_slot));
        if (!ns) abort();
        size_t mask = ncap - 1;
        for (size_t i = 0; i < cap; i++) {
            if (slots[i].gen != gen) continue;
            size_t j = slot_of(slots[i].first, mask);
            while (ns[j].gen) j = (j + 1) & mask;
            ns[j] = slots[i];
        }
        free(slots);
        slots = ns;
        cap = ncap;
    }
public:
    typedef fast_trans_slot* iterator;

    fast_trans_table() {
        used = 0;
        if (++gen == 0) { // поколения кончились — честно чистим массив
            if (slots) memset(slots, 0, cap * sizeof(fast_trans_slot));
            gen = 1;
        }
        if (!slots) grow();
    }
    iterator end() const { return 0; }
    iterator find(board_t key) const {
        size_t mask = cap - 1, j = slot_of(key, mask);
        while (slots[j].gen == gen) {
            if (slots[j].first == key) return &slots[j];
            j = (j + 1) & mask;
        }
        return 0;
    }
    trans_table_entry_t& operator[](board_t key) {
        iterator it = find(key);
        if (it) return it->second;
        if ((used + 1) * 2 > cap) grow();
        size_t mask = cap - 1, j = slot_of(key, mask);
        while (slots[j].gen == gen) j = (j + 1) & mask;
        slots[j].first = key;
        slots[j].second = trans_table_entry_t();
        slots[j].gen = gen;
        used++;
        return slots[j].second;
    }
    size_t size() const { return used; }
};

fast_trans_slot* fast_trans_table::slots = 0;
size_t fast_trans_table::cap = 0;
size_t fast_trans_table::used = 0;
uint32_t fast_trans_table::gen = 0;
