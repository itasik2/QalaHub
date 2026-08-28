'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type CatalogService = { id: string; slug: string; name: string };
type CatalogCategory = {
  id: string;
  slug: string;
  name: string;
  services: CatalogService[];
};
type Catalog = { categories: CatalogCategory[] };

type Dashboard = {
  provider: {
    id: string;
    status: string;
    availability: string;
    availableUntil?: string | null;
    activeJobs: number;
    rating: number;
    city: { name: string };
    user: { name?: string | null; phone?: string | null; phoneVerifiedAt?: string | null };
    services: Array<{
      minPrice?: number | null;
      maxPrice?: number | null;
      service: { slug: string; name: string; category: { slug: string; name: string } };
    }>;
  };
  readiness: {
    ready: boolean;
    status: string;
    missing: string[];
    nextAction?: string | null;
  };
  pendingDispatches: Array<{
    id: string;
    expiresAt: string;
    request: {
      id: string;
      title: string;
      description?: string | null;
      urgency: string;
      category: { name: string };
      service?: { name: string } | null;
    };
  }>;
  activeOrders: Array<{
    id: string;
    status: string;
    request: { id: string; title: string; description?: string | null };
    offer: { amountKzt?: number | null; etaMinutes?: number | null };
  }>;
};

type PriceDraft = Record<string, { enabled: boolean; min: string; max: string }>;
type DispatchDraft = Record<string, { amount: string; eta: string }>;

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1';

const readinessLabels: Record<string, string> = {
  PHONE_UNVERIFIED: 'Подтвердить номер телефона',
  NAME_REQUIRED: 'Указать имя',
  CITY_INACTIVE: 'Выбрать активный город',
  LOCATION_REQUIRED: 'Указать рабочую точку',
  SERVICE_RADIUS_INVALID: 'Указать радиус работы',
  SERVICE_REQUIRED: 'Выбрать хотя бы одну услугу',
  SERVICE_PRICE_REQUIRED: 'Указать диапазон цен',
};

function money(value?: number | null) {
  return value == null ? 'по договорённости' : `${new Intl.NumberFormat('ru-KZ').format(value)} ₸`;
}

export function ProviderConsole() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [latitude, setLatitude] = useState('52.287');
  const [longitude, setLongitude] = useState('76.967');
  const [radius, setRadius] = useState('10');
  const [prices, setPrices] = useState<PriceDraft>({});
  const [dispatchDrafts, setDispatchDrafts] = useState<DispatchDraft>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadDashboard = useCallback(async (id: string) => {
    const response = await fetch(`${apiBase}/providers/${id}/dashboard`, { cache: 'no-store' });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(body?.message ?? 'Не удалось загрузить кабинет');
    setDashboard(body);
    setPhone(body.provider.user.phone ?? '');
    setName(body.provider.user.name ?? '');
    return body as Dashboard;
  }, []);

  useEffect(() => {
    const savedProviderId = localStorage.getItem('qalahub:provider:id');
    if (savedProviderId) setProviderId(savedProviderId);

    fetch(`${apiBase}/catalog/pavlodar`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json() as Promise<Catalog>;
      })
      .then((data) => {
        setCatalog(data);
        const initial: PriceDraft = {};
        for (const category of data.categories) {
          for (const service of category.services) {
            initial[`${category.slug}/${service.slug}`] = {
              enabled: false,
              min: '5000',
              max: '20000',
            };
          }
        }
        setPrices(initial);
      })
      .catch(() => setError('Не удалось загрузить каталог услуг.'));
  }, []);

  useEffect(() => {
    if (!providerId) return;
    let disposed = false;

    const refresh = async () => {
      try {
        const data = await loadDashboard(providerId);
        if (disposed) return;
        setError(null);
        setPrices((current) => {
          const next = { ...current };
          for (const item of data.provider.services) {
            const key = `${item.service.category.slug}/${item.service.slug}`;
            next[key] = {
              enabled: true,
              min: String(item.minPrice ?? 5000),
              max: String(item.maxPrice ?? 20000),
            };
          }
          return next;
        });
      } catch (dashboardError) {
        if (!disposed) {
          setError(dashboardError instanceof Error ? dashboardError.message : 'Не удалось загрузить кабинет');
        }
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [loadDashboard, providerId]);

  const selectedServices = useMemo(() => {
    if (!catalog) return [];
    return catalog.categories.flatMap((category) =>
      category.services.flatMap((service) => {
        const key = `${category.slug}/${service.slug}`;
        const draft = prices[key];
        if (!draft?.enabled) return [];
        return [{ category, service, draft }];
      }),
    );
  }, [catalog, prices]);

  async function startOnboarding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('start');
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${apiBase}/providers/onboarding/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim(), name: name.trim(), citySlug: 'pavlodar' }),
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(body?.message ?? 'Не удалось начать регистрацию');
      localStorage.setItem('qalahub:provider:id', body.providerId);
      setProviderId(body.providerId);
      setNotice('Профиль создан. Заполните услуги и рабочий радиус.');
      await loadDashboard(body.providerId);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Не удалось начать регистрацию');
    } finally {
      setBusy(null);
    }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providerId) return;
    if (selectedServices.length === 0) {
      setError('Выберите хотя бы одну услугу.');
      return;
    }

    setBusy('profile');
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${apiBase}/providers/${providerId}/onboarding/profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          citySlug: 'pavlodar',
          latitude: Number(latitude),
          longitude: Number(longitude),
          serviceRadiusKm: Number(radius),
          services: selectedServices.map(({ category, service, draft }) => ({
            categorySlug: category.slug,
            serviceSlug: service.slug,
            minPrice: Number(draft.min),
            maxPrice: Number(draft.max),
          })),
        }),
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(body?.message ?? 'Не удалось сохранить профиль');
      setNotice(body.readiness.ready ? 'Профиль готов к заказам.' : 'Профиль сохранён. Остались шаги проверки.');
      await loadDashboard(providerId);
    } catch (profileError) {
      setError(profileError instanceof Error ? profileError.message : 'Не удалось сохранить профиль');
    } finally {
      setBusy(null);
    }
  }

  function useLocation() {
    if (!navigator.geolocation) {
      setError('Браузер не поддерживает определение местоположения.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLatitude(position.coords.latitude.toFixed(6));
        setLongitude(position.coords.longitude.toFixed(6));
        setNotice('Точка работы обновлена по местоположению браузера.');
      },
      () => setError('Не удалось получить местоположение. Координаты можно указать вручную.'),
      { enableHighAccuracy: false, timeout: 8000 },
    );
  }

  async function setAvailability(status: 'AVAILABLE' | 'OFFLINE') {
    if (!providerId) return;
    setBusy(`availability:${status}`);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/providers/${providerId}/availability`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(status === 'AVAILABLE' ? { status, minutes: 240 } : { status }),
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(body?.message ?? 'Не удалось изменить доступность');
      await loadDashboard(providerId);
    } catch (availabilityError) {
      setError(availabilityError instanceof Error ? availabilityError.message : 'Не удалось изменить доступность');
    } finally {
      setBusy(null);
    }
  }

  async function respondToDispatch(attemptId: string, responseValue: 'ACCEPTED' | 'DECLINED') {
    if (!providerId) return;
    const draft = dispatchDrafts[attemptId] ?? { amount: '10000', eta: '30' };
    setBusy(`dispatch:${attemptId}`);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/provider-dispatch/${attemptId}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          responseValue === 'ACCEPTED'
            ? {
                response: responseValue,
                amountKzt: Number(draft.amount),
                etaMinutes: Number(draft.eta),
                comment: 'Готов выполнить заказ',
              }
            : { response: responseValue },
        ),
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(body?.message ?? 'Не удалось ответить на заявку');
      await loadDashboard(providerId);
    } catch (dispatchError) {
      setError(dispatchError instanceof Error ? dispatchError.message : 'Не удалось ответить на заявку');
    } finally {
      setBusy(null);
    }
  }

  async function changeOrder(orderId: string, action: 'start' | 'complete') {
    if (!providerId) return;
    setBusy(`order:${orderId}`);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/providers/${providerId}/orders/${orderId}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(body?.message ?? 'Не удалось изменить заказ');
      await loadDashboard(providerId);
    } catch (orderError) {
      setError(orderError instanceof Error ? orderError.message : 'Не удалось изменить заказ');
    } finally {
      setBusy(null);
    }
  }

  function forgetProfile() {
    localStorage.removeItem('qalahub:provider:id');
    setProviderId(null);
    setDashboard(null);
    setNotice('Локальная привязка профиля удалена с этого браузера.');
  }

  if (!providerId) {
    return (
      <main className="shell narrowShell">
        <nav className="topbar">
          <a className="brand" href="/">QalaHub</a>
          <a className="secondaryButton smallButton" href="/">Я заказчик</a>
        </nav>
        <section className="hero compactHero">
          <div className="eyebrow">Исполнитель · Павлодар</div>
          <h1 className="pageTitle">Подключитесь к автоматической раздаче заказов</h1>
          <p className="lead smallLead">Заполните профиль один раз. Дальше вы сами включаете доступность и получаете только подходящие заявки.</p>

          <form className="requestBox" onSubmit={startOnboarding}>
            <div className="formGrid twoColumns">
              <label>
                <span>Имя или название</span>
                <input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} />
              </label>
              <label>
                <span>Телефон</span>
                <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+7..." required inputMode="tel" />
              </label>
            </div>
            {error ? <div className="formError">{error}</div> : null}
            <button className="primaryButton" type="submit" disabled={busy !== null}>{busy === 'start' ? 'Создаём профиль…' : 'Продолжить'}</button>
          </form>
        </section>
      </main>
    );
  }

  if (!dashboard) {
    return <main className="shell narrowShell"><section className="hero compactHero"><h1 className="pageTitle">Загружаем кабинет…</h1>{error ? <div className="formError">{error}</div> : null}</section></main>;
  }

  return (
    <main className="shell">
      <nav className="topbar">
        <a className="brand" href="/">QalaHub</a>
        <div className="topbarActions">
          <span>{dashboard.provider.user.name || 'Исполнитель'} · {dashboard.provider.city.name}</span>
          <button className="textButton" type="button" onClick={forgetProfile}>Сменить профиль</button>
        </div>
      </nav>

      <section className="providerSummary">
        <div>
          <div className="eyebrow">Кабинет исполнителя</div>
          <h1 className="providerTitle">{dashboard.provider.user.name || 'Исполнитель QalaHub'}</h1>
          <div className="providerStats">
            <span>Статус <strong>{dashboard.provider.status}</strong></span>
            <span>Доступность <strong>{dashboard.provider.availability}</strong></span>
            <span>Активных заказов <strong>{dashboard.provider.activeJobs}</strong></span>
            <span>Рейтинг <strong>{dashboard.provider.rating.toFixed(1)}</strong></span>
          </div>
        </div>
        {dashboard.readiness.ready ? (
          <div className="availabilityActions">
            <button className="primaryButton" type="button" onClick={() => void setAvailability('AVAILABLE')} disabled={busy !== null}>Принимаю заказы</button>
            <button className="secondaryButton" type="button" onClick={() => void setAvailability('OFFLINE')} disabled={busy !== null}>Не принимаю</button>
          </div>
        ) : null}
      </section>

      {notice ? <div className="noticeBox">{notice}</div> : null}
      {error ? <div className="formError standaloneError">{error}</div> : null}

      {!dashboard.readiness.ready ? (
        <section className="section">
          <div className="sectionHeader">
            <div>
              <div className="eyebrow">Onboarding</div>
              <h2>Завершите профиль</h2>
            </div>
            <div className="readinessList">
              {dashboard.readiness.missing.map((code) => <span key={code}>{readinessLabels[code] ?? code}</span>)}
            </div>
          </div>

          {!dashboard.provider.user.phoneVerifiedAt ? (
            <div className="verificationNotice">
              <strong>Номер ещё не подтверждён</strong>
              <p>Профиль и услуги можно заполнить сейчас. Для выхода в ACTIVE требуется подтверждение номера через подключаемый SMS/auth-шлюз.</p>
            </div>
          ) : null}

          <form onSubmit={saveProfile}>
            <div className="formGrid twoColumns">
              <label>
                <span>Имя или название</span>
                <input value={name} onChange={(event) => setName(event.target.value)} required />
              </label>
              <label>
                <span>Радиус работы, км</span>
                <input value={radius} onChange={(event) => setRadius(event.target.value)} type="number" min="1" max="50" required />
              </label>
              <label>
                <span>Широта</span>
                <input value={latitude} onChange={(event) => setLatitude(event.target.value)} type="number" step="0.000001" required />
              </label>
              <label>
                <span>Долгота</span>
                <input value={longitude} onChange={(event) => setLongitude(event.target.value)} type="number" step="0.000001" required />
              </label>
            </div>
            <button className="secondaryButton locationButton" type="button" onClick={useLocation}>Использовать моё местоположение</button>

            <div className="serviceEditor">
              <div className="eyebrow">Услуги и цены</div>
              {(catalog?.categories ?? []).flatMap((category) => category.services.map((service) => {
                const key = `${category.slug}/${service.slug}`;
                const draft = prices[key] ?? { enabled: false, min: '5000', max: '20000' };
                return (
                  <div className="serviceRow" key={key}>
                    <label className="checkLabel">
                      <input type="checkbox" checked={draft.enabled} onChange={(event) => setPrices((current) => ({ ...current, [key]: { ...draft, enabled: event.target.checked } }))} />
                      <span><strong>{service.name}</strong><small>{category.name}</small></span>
                    </label>
                    <input aria-label="Минимальная цена" value={draft.min} onChange={(event) => setPrices((current) => ({ ...current, [key]: { ...draft, min: event.target.value } }))} type="number" min="0" disabled={!draft.enabled} />
                    <input aria-label="Максимальная цена" value={draft.max} onChange={(event) => setPrices((current) => ({ ...current, [key]: { ...draft, max: event.target.value } }))} type="number" min="0" disabled={!draft.enabled} />
                  </div>
                );
              }))}
            </div>

            <button className="primaryButton" type="submit" disabled={busy !== null}>{busy === 'profile' ? 'Сохраняем…' : 'Сохранить профиль'}</button>
          </form>
        </section>
      ) : null}

      {dashboard.pendingDispatches.length > 0 ? (
        <section className="section">
          <div className="eyebrow">Новые заявки</div>
          <h2>Нужен ваш ответ</h2>
          <div className="dispatchList">
            {dashboard.pendingDispatches.map((attempt) => {
              const draft = dispatchDrafts[attempt.id] ?? { amount: '10000', eta: '30' };
              return (
                <article className="dispatchCard" key={attempt.id}>
                  <div>
                    <span className="urgencyBadge">{attempt.request.urgency}</span>
                    <h3>{attempt.request.title}</h3>
                    <p>{attempt.request.description || 'Без дополнительного описания'}</p>
                    <small>{attempt.request.category.name}{attempt.request.service ? ` · ${attempt.request.service.name}` : ''}</small>
                  </div>
                  <div className="dispatchDecision">
                    <label><span>Цена, ₸</span><input type="number" min="0" value={draft.amount} onChange={(event) => setDispatchDrafts((current) => ({ ...current, [attempt.id]: { ...draft, amount: event.target.value } }))} /></label>
                    <label><span>Приеду через, мин.</span><input type="number" min="1" value={draft.eta} onChange={(event) => setDispatchDrafts((current) => ({ ...current, [attempt.id]: { ...draft, eta: event.target.value } }))} /></label>
                    <div className="buttonRow">
                      <button className="primaryButton" type="button" onClick={() => void respondToDispatch(attempt.id, 'ACCEPTED')} disabled={busy !== null}>Принять</button>
                      <button className="secondaryButton" type="button" onClick={() => void respondToDispatch(attempt.id, 'DECLINED')} disabled={busy !== null}>Отказаться</button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : dashboard.readiness.ready ? (
        <section className="section emptyState">
          <div className="eyebrow">Входящие</div>
          <h2>Новых заявок сейчас нет</h2>
          <p>Когда matching выберет вас для подходящей задачи, она появится здесь автоматически.</p>
        </section>
      ) : null}

      {dashboard.activeOrders.length > 0 ? (
        <section className="section">
          <div className="eyebrow">Текущие заказы</div>
          <h2>Работа в процессе</h2>
          <div className="orderList">
            {dashboard.activeOrders.map((order) => (
              <article className="orderCard" key={order.id}>
                <div>
                  <span className="urgencyBadge">{order.status}</span>
                  <h3>{order.request.title}</h3>
                  <p>{order.request.description || 'Без дополнительного описания'}</p>
                  <strong>{money(order.offer.amountKzt)}</strong>
                </div>
                <div className="buttonRow">
                  {order.status === 'CONFIRMED' ? <button className="primaryButton" type="button" onClick={() => void changeOrder(order.id, 'start')} disabled={busy !== null}>Начать работу</button> : null}
                  {order.status === 'IN_PROGRESS' ? <button className="primaryButton" type="button" onClick={() => void changeOrder(order.id, 'complete')} disabled={busy !== null}>Завершить работу</button> : null}
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
