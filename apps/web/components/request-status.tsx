'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type Provider = {
  id: string;
  rating: number;
  activeJobs: number;
  user: { name?: string | null };
};

type Offer = {
  id: string;
  providerId: string;
  amountKzt?: number | null;
  etaMinutes?: number | null;
  comment?: string | null;
  status: string;
  provider: Provider;
};

type RequestState = {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  customerPriceKzt?: number | null;
  recommendedMinPriceKzt?: number | null;
  recommendedMaxPriceKzt?: number | null;
  offerSelectionExpiresAt?: string | null;
  offerSelectionTimeoutSeconds?: number;
  offers: Offer[];
  dispatchAttempts: Array<{ id: string; response?: string | null }>;
  order?: {
    id: string;
    status: string;
    providerId: string;
    offer: Offer;
    provider: Provider;
  } | null;
  exceptions: Array<{ id: string; code: string; status: string }>;
};

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1';

const labels: Record<string, string> = {
  CREATED: 'Заявка создана',
  MATCHING: 'Ищем исполнителей',
  DISPATCHING: 'Отправляем запросы',
  WAITING_RESPONSES: 'Ждём ответы исполнителей',
  OFFERS_RECEIVED: 'Есть предложения',
  PROVIDER_SELECTED: 'Исполнитель выбран',
  CONFIRMED: 'Заказ подтверждён',
  IN_PROGRESS: 'Работа выполняется',
  COMPLETED: 'Работа завершена',
  CANCELLED: 'Заявка отменена',
  EXPIRED: 'Срок заявки истёк',
  FAILED_TO_MATCH: 'Исполнитель не найден',
};

const terminalStatuses = new Set(['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED_TO_MATCH']);

function money(value?: number | null) {
  return value == null ? 'Цена по договорённости' : `${new Intl.NumberFormat('ru-KZ').format(value)} ₸`;
}

function priceRange(request: RequestState) {
  const min = request.recommendedMinPriceKzt;
  const max = request.recommendedMaxPriceKzt;
  if (min != null && max != null) return `${money(min)}–${money(max)}`;
  if (min != null) return `от ${money(min)}`;
  if (max != null) return `до ${money(max)}`;
  return null;
}

export function RequestStatus({ requestId }: { requestId: string }) {
  const [request, setRequest] = useState<RequestState | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [accessLoaded, setAccessLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('OTHER');

  const tokenHeaders = useCallback((): Record<string, string> => {
    return accessToken ? { 'x-qalahub-request-token': accessToken } : {};
  }, [accessToken]);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const response = await fetch(`${apiBase}/requests/${requestId}`, {
        cache: 'no-store',
        headers: tokenHeaders(),
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(body?.message ?? 'Не удалось загрузить заявку');
      setRequest(body);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить заявку');
    }
  }, [accessToken, requestId, tokenHeaders]);

  useEffect(() => {
    const token = localStorage.getItem(`qalahub:request:${requestId}:token`);
    setAccessToken(token);
    setAccessLoaded(true);
    if (!token) {
      setError('Доступ к этой заявке не сохранён в браузере. Создайте новую заявку или откройте её на устройстве, где она была создана.');
    }
  }, [requestId]);

  useEffect(() => {
    if (!accessToken) return;
    void load();
  }, [accessToken, load]);

  useEffect(() => {
    if (!accessToken || !request || terminalStatuses.has(request.status)) return;
    const timer = window.setInterval(() => void load(), 1800);
    return () => window.clearInterval(timer);
  }, [accessToken, load, request]);

  const pendingOffers = useMemo(
    () => request?.offers.filter((offer) => offer.status === 'PENDING') ?? [],
    [request],
  );
  const selectionExpired = useMemo(
    () =>
      request?.status === 'OFFERS_RECEIVED' &&
      pendingOffers.length === 0 &&
      request.offers.some((offer) => offer.status === 'EXPIRED'),
    [pendingOffers.length, request],
  );

  async function selectOffer(offerId: string) {
    if (!accessToken) return;
    setActionId(offerId);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/requests/${requestId}/offers/${offerId}/select`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...tokenHeaders(),
        },
        body: '{}',
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(body?.message ?? 'Не удалось выбрать исполнителя');
      await load();
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : 'Не удалось выбрать исполнителя');
    } finally {
      setActionId(null);
    }
  }

  async function rejectOffersAndResume() {
    if (!accessToken) return;
    setActionId('reject-all');
    setError(null);
    try {
      const response = await fetch(`${apiBase}/requests/${requestId}/offers/reject-all`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...tokenHeaders(),
        },
        body: JSON.stringify({ reason: rejectionReason }),
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(body?.message ?? 'Не удалось продолжить поиск');
      await load();
    } catch (rejectError) {
      setError(rejectError instanceof Error ? rejectError.message : 'Не удалось продолжить поиск');
    } finally {
      setActionId(null);
    }
  }

  async function resumeMatching() {
    if (!accessToken) return;
    setActionId('resume');
    setError(null);
    try {
      const response = await fetch(`${apiBase}/requests/${requestId}/offers/resume`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...tokenHeaders(),
        },
        body: '{}',
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(body?.message ?? 'Не удалось возобновить поиск');
      await load();
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : 'Не удалось возобновить поиск');
    } finally {
      setActionId(null);
    }
  }

  async function cancelRequest() {
    if (!accessToken) return;
    setActionId('cancel');
    setError(null);
    try {
      const response = await fetch(`${apiBase}/requests/${requestId}/cancel`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...tokenHeaders(),
        },
        body: JSON.stringify({ reason: 'Отменено заказчиком' }),
      });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(body?.message ?? 'Не удалось отменить заявку');
      await load();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Не удалось отменить заявку');
    } finally {
      setActionId(null);
    }
  }

  if (!accessLoaded || (!request && accessToken)) {
    return (
      <main className="shell narrowShell">
        <section className="hero compactHero">
          <div className="eyebrow">QalaHub</div>
          <h1 className="pageTitle">{error ?? 'Загружаем заявку…'}</h1>
        </section>
      </main>
    );
  }

  if (!accessToken || !request) {
    return (
      <main className="shell narrowShell">
        <a className="backLink" href="/">← Новая заявка</a>
        <section className="hero compactHero">
          <div className="eyebrow">Защищённая заявка</div>
          <h1 className="pageTitle">Нет доступа к заявке</h1>
          <p className="lead smallLead">{error ?? 'Ключ доступа отсутствует в этом браузере.'}</p>
        </section>
      </main>
    );
  }

  const canCancel = !['IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(request.status);
  const recommended = priceRange(request);

  return (
    <main className="shell narrowShell">
      <a className="backLink" href="/">← Новая заявка</a>

      <section className="hero compactHero">
        <div className="statusLine">
          <span className={`statusDot status-${request.status.toLowerCase()}`} />
          <span>{labels[request.status] ?? request.status}</span>
        </div>
        <h1 className="pageTitle">{request.title}</h1>
        {request.description ? <p className="lead smallLead">{request.description}</p> : null}
        {request.customerPriceKzt != null || recommended ? (
          <p className="mutedText">
            {request.customerPriceKzt != null ? `Ваш ориентир: ${money(request.customerPriceKzt)}.` : 'Ваша цена не указана.'}
            {recommended ? ` Рекомендованный диапазон: ${recommended}.` : ''}
          </p>
        ) : null}

        <div className="metricRow">
          <div className="metricCard">
            <strong>{request.dispatchAttempts.length}</strong>
            <span>запросов отправлено</span>
          </div>
          <div className="metricCard">
            <strong>{request.offers.length}</strong>
            <span>предложений получено</span>
          </div>
          <div className="metricCard">
            <strong>{request.exceptions.length}</strong>
            <span>исключений системы</span>
          </div>
        </div>
      </section>

      {pendingOffers.length > 0 ? (
        <section className="section">
          <div className="sectionHeader">
            <div>
              <div className="eyebrow">Предложения</div>
              <h2>Выберите исполнителя</h2>
              {request.offerSelectionExpiresAt ? (
                <p className="mutedText">
                  Текущий набор предложений действует до {new Date(request.offerSelectionExpiresAt).toLocaleTimeString('ru-KZ', { hour: '2-digit', minute: '2-digit' })}.
                </p>
              ) : null}
            </div>
          </div>
          <div className="offerList">
            {pendingOffers.map((offer) => (
              <article className="offerCard" key={offer.id}>
                <div>
                  <strong className="offerName">{offer.provider.user.name || 'Исполнитель QalaHub'}</strong>
                  <div className="offerMeta">
                    Рейтинг {offer.provider.rating.toFixed(1)} · активных заказов {offer.provider.activeJobs}
                  </div>
                  {offer.comment ? <p>{offer.comment}</p> : null}
                </div>
                <div className="offerDecision">
                  <strong>{money(offer.amountKzt)}</strong>
                  <span>{offer.etaMinutes ? `Приедет примерно через ${offer.etaMinutes} мин.` : 'Время уточняется'}</span>
                  <button
                    className="primaryButton"
                    type="button"
                    onClick={() => void selectOffer(offer.id)}
                    disabled={actionId !== null}
                  >
                    {actionId === offer.id ? 'Выбираем…' : 'Выбрать'}
                  </button>
                </div>
              </article>
            ))}
          </div>

          <div className="cancelPanel">
            <div>
              <strong>Никто не подходит?</strong>
              <p className="mutedText">Текущие предложения будут отклонены, а система продолжит со следующей волны и при необходимости расширит зону поиска.</p>
              <label>
                <span>Причина</span>
                <select value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} disabled={actionId !== null}>
                  <option value="TOO_EXPENSIVE">Слишком дорого</option>
                  <option value="ETA_TOO_LONG">Слишком долго ждать</option>
                  <option value="NOT_SUITABLE">Не подходят условия или исполнитель</option>
                  <option value="NEED_OTHER_SPECIALIST">Нужен другой специалист</option>
                  <option value="OTHER">Другая причина</option>
                </select>
              </label>
            </div>
            <button className="secondaryButton" type="button" onClick={() => void rejectOffersAndResume()} disabled={actionId !== null}>
              {actionId === 'reject-all' ? 'Продолжаем поиск…' : 'Искать другие варианты'}
            </button>
          </div>
        </section>
      ) : null}

      {selectionExpired ? (
        <section className="section waitingPanel">
          <div>
            <strong>Время выбора истекло</strong>
            <p>Старые предложения закрыты. Можно продолжить поиск: система перейдёт к следующим исполнителям и при необходимости расширит зону.</p>
          </div>
          <button className="primaryButton" type="button" onClick={() => void resumeMatching()} disabled={actionId !== null}>
            {actionId === 'resume' ? 'Возобновляем…' : 'Продолжить поиск'}
          </button>
        </section>
      ) : null}

      {request.order ? (
        <section className="section orderPanel">
          <div className="eyebrow">Заказ</div>
          <h2>{labels[request.order.status] ?? request.order.status}</h2>
          <div className="orderGrid">
            <div>
              <span>Исполнитель</span>
              <strong>{request.order.provider.user.name || 'Исполнитель QalaHub'}</strong>
            </div>
            <div>
              <span>Стоимость</span>
              <strong>{money(request.order.offer.amountKzt)}</strong>
            </div>
            <div>
              <span>Ожидаемое прибытие</span>
              <strong>{request.order.offer.etaMinutes ? `${request.order.offer.etaMinutes} мин.` : 'Уточняется'}</strong>
            </div>
          </div>
        </section>
      ) : null}

      {!request.order && pendingOffers.length === 0 && !selectionExpired && !terminalStatuses.has(request.status) ? (
        <section className="section waitingPanel">
          <div className="spinner" aria-hidden="true" />
          <div>
            <strong>Подбор идёт автоматически</strong>
            <p>Система отправляет запросы подходящим исполнителям волнами. Страница обновляется сама.</p>
          </div>
        </section>
      ) : null}

      {error ? <div className="formError standaloneError">{error}</div> : null}

      {canCancel ? (
        <section className="cancelPanel">
          <div>
            <strong>Заказ больше не нужен?</strong>
            <p className="mutedText">До начала работы заявку можно отменить без участия администратора.</p>
          </div>
          <button className="secondaryButton" type="button" onClick={() => void cancelRequest()} disabled={actionId !== null}>
            {actionId === 'cancel' ? 'Отменяем…' : 'Отменить заявку'}
          </button>
        </section>
      ) : null}
    </main>
  );
}
