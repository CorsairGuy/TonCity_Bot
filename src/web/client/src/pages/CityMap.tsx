import { Navigate, useSearchParams } from 'react-router-dom';
import { CityMapCapital } from './CityMapCapital';

// Тонкий диспетчер: карта города и карта столицы — принципиально разные формулы цены/доступности
// (скидки гильдии и политик у городов vs. hall_lvl_required/econStrength у столиц) и разный набор
// вкладок сайдбара, поэтому это два отдельных компонента (CityMapCity/CityMapCapital), а не одна
// ветвящаяся логика на 2000+ строк — см. план в соответствующей задаче.
export function CityMap() {
  const [searchParams] = useSearchParams();
  const account = searchParams.get('account') ?? '';
  const mapType = searchParams.get('type') === 'capital' ? 'capital' : 'city';
  // город открывается на общей карте всех городов, сразу приближенным (старые ссылки /city-map?account=)
  return mapType === 'capital' ? <CityMapCapital account={account} /> : <Navigate to={account ? `/city?account=${encodeURIComponent(account)}` : '/city'} replace />;
}
