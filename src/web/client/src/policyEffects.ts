// Официальный словарь читаемых названий эффектов политик — реверс-инжиниринг i18n-строк и
// функций-форматеров клиента игры (chunks/entry-*.js: V2e — название эффекта, G2e — значение,
// H2e — нормализация типов зданий для building_type_income).

export const POLICY_STAT_LABEL: Record<string, string> = {
  global_income: 'Доход города',
  category_income: 'Доход',
  building_type_income: 'Доход',
  happiness_floor: 'Нижний порог счастья',
  happiness_ceiling: 'Максимум счастья',
  service_category_coverage: 'Покрытие',
  total_coverage: 'Общее покрытие служб',
  population: 'Население',
  upgrade_cost: 'Стоимость улучшений',
  build_cost: 'Стоимость строительства',
  construction_time: 'Время строительства',
  offline_window: 'Окно офлайн-дохода',
  concurrent_builders: 'Число строителей',
  renovation_masterplan_count: 'Мастерпланов на реновацию',
  urban_vitality_requirement: 'Требования урбанизации',
  daily_shard_grant: 'Ежедневные осколки',
  daily_item_grant: 'Ежедневные бонусные предметы',
  daily_item_grant_scoped: 'Ежедневно',
  item_sell_value: 'Стоимость продажи предметов',
  shop_purchase_discount: 'Цены в магазине',
  shard_drop_rate: 'Частота Городского розыгрыша',
  market_commission: 'Комиссия рынка',
  listing_limit: 'Лимит лотов на рынке',
  purchase_limit: 'Лимит покупок на рынке',
  listing_limit_scoped: 'Лимит лотов',
  purchase_limit_scoped: 'Лимит покупок',
  minigame_reward: 'Награды мини-игр',
  satoshi_max_leverage: 'Макс. плечо в Башне Сатоши',
  satoshi_fees: 'Комиссии Башни Сатоши',
  staking_rate: 'Доход стейкинга',
  staking_tier_unlock: 'Открывает высшие уровни стейкинга',
  fortune_spins: 'Вращения в Павильоне удачи',
  daily_reward_bonus: 'Ежедневные награды',
  raid_attack_power: 'Сила атаки в рейдах',
  raid_defense_power: 'Сила обороны в рейдах',
  raid_spoils: 'Трофеи рейдов и Почёт',
  mobilized_bane_removal: 'Снимает штраф мобилизации',
  tech_factory_recipe_speed: 'Скорость рецептов Тех. фабрики',
  capital_benefit_amplifier: 'Получаемые бонусы столицы',
  diversity_bonus: 'Эффективные очки разнообразия',
  tenure_rate: 'Скорость стажа',
  slot_synergy: 'Синергия слотов',
};

export const POLICY_TARGET_LABEL: Record<string, string> = {
  residential: 'жильё', commercial: 'коммерция', service: 'службы', special: 'особые',
  park: 'парки и сады', 'police-station': 'полиция', 'fire-station': 'пожарные', hospital: 'больницы',
  banks: 'банки', offices: 'офисы', startup_hubs: 'Инкубаторы стартапов', grand_arcanum: 'Гранд Арканумы',
  select_buildings: 'отдельные здания', mid_commercial: 'коммерция среднего уровня',
  epic_booster: 'эпические ускорители', legendary_booster: 'легендарные ускорители', mythic_booster: 'мифические ускорители',
  epic_pack: 'эпические наборы', legendary_pack: 'легендарные наборы', mythic_pack: 'мифические наборы',
  masterplan: 'мастерпланы', component: 'компоненты',
  epic_shard: 'эпические осколки', legendary_shard: 'легендарные осколки', mythic_shard: 'мифические осколки',
  epic_mystery: 'эпические тайные политики', legendary_mystery: 'легендарные тайные политики', mythic_mystery: 'мифические тайные политики',
  epic_policy: 'эпические политики', legendary_policy: 'легендарные политики', mythic_policy: 'мифические политики',
};

// H2e из клиента: сырые id типов зданий (building_type_income.targets) → категория
function normalizeBuildingType(raw: string): string {
  if (raw.startsWith('COM_bank')) return 'banks';
  if (raw.startsWith('COM_office_tower')) return 'offices';
  if (raw.startsWith('COM_startup_hub')) return 'startup_hubs';
  if (raw.startsWith('COM_grand_arcanum')) return 'grand_arcanum';
  return 'select_buildings';
}

// j2e из клиента — эти add-статы форматируются в процентах
const PERCENT_ADD_STATS = new Set(['happiness_floor', 'happiness_ceiling', 'market_commission']);

export interface RawPolicyEffect {
  stat: string;
  scope_kind?: string;
  targets?: string[];
  mode: 'mult' | 'add' | 'set' | 'flag';
  value: number;
  kind?: 'boon' | 'bane';
}

const t = (k: string) => POLICY_TARGET_LABEL[k] ?? k;

// V2e из клиента: название эффекта — некоторые статы подставляют цель(и) в текст
export function effectLabel(e: RawPolicyEffect): string {
  const targets = e.targets ?? [];
  switch (e.stat) {
    case 'category_income':
      return `Доход: ${t(targets[0])}`;
    case 'building_type_income': {
      const uniq = [...new Set(targets.map(normalizeBuildingType))].sort();
      const key = uniq.length === 1 ? uniq[0]
        : uniq.join(',') === 'banks,offices,startup_hubs' ? 'mid_commercial' : 'select_buildings';
      return `Доход: ${t(key)}`;
    }
    case 'service_category_coverage':
      return `Покрытие: ${targets.map(t).join(' & ')}`;
    case 'daily_item_grant':
    case 'listing_limit':
    case 'purchase_limit':
      if (targets.length === 0) return POLICY_STAT_LABEL[e.stat] ?? e.stat;
      return `${POLICY_STAT_LABEL[`${e.stat}_scoped`] ?? e.stat}: ${t(targets[0])}`;
    default:
      return POLICY_STAT_LABEL[e.stat] ?? e.stat;
  }
}

// af/lf из клиента: знак + округление до десятых, минус — типографский «−»
function fmtSigned(n: number): string {
  const r = Math.round(n * 10) / 10;
  return r >= 0 ? `+${r}` : `−${Math.abs(r)}`;
}

// G2e из клиента: значение эффекта (уже со знаком — не добавляйте "+" отдельно)
export function effectValue(e: RawPolicyEffect, value = e.value): string {
  switch (e.mode) {
    case 'mult': return `${fmtSigned(value * 100)}%`;
    case 'set': return `${value}×`;
    case 'flag': return '';
    case 'add':
      if (e.stat === 'offline_window') return `${fmtSigned(value)}ч`;
      if (PERCENT_ADD_STATS.has(e.stat)) return `${fmtSigned(value)}%`;
      if (e.stat === 'renovation_masterplan_count') return fmtSigned(-value);
      return fmtSigned(value);
    default: return String(value);
  }
}
