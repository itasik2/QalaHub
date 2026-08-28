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

export function RequestStatus({ requestId }: { requestId: string }) {
  const [request, setRequest] = useState<RequestState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [cancelPhone, setCancelPhone] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/requests/${requestId}`, { cache: 'no-store' });
      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(body?.message ?? 'Не удалось загрузить заявку');
      setRequest(body);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить заявку');
    }
  }, [requestId]);

  useEffect(() => {
    setCancelPhone(sessionStorage.getItem(`qalahub:request:${requestId}:phone`) ?? '');
    void load();
  }, [load, requestId]);

  useEffect(() => {
    if (!request || terminalStatuses.has(request.status) || request.status === 'CONFIRMED') return;
    const timer = window.setInterval(() => void load(), 1800);
    return () => window.clearInterval(timer);
  }, [load, request]);

  const pendingOffers = useMemo(
    () => request?.offers.filter((offer) => offer.status === 'PENDING') ?? [],
    [request],
  );

  async function selectOffer(offerId: string) {
    setActionId(offerId);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/requests/${requestId}/offers/${offerId}/select`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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

  async function cancelRequest() {
    if (!cancelPhone.trim()) {
      setError('Введите номер телефона, указанный при создании заявки.');
      return;
    }
    setActionId('cancel');
    setError(null);
    try {
      const response = await fetch(`${apiBase}/requests/${requestId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customerPhone: cancelPhone.trim(), reason: 'Отменено заказчиком' }),
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

  if (!request) {
    return (
      <main className="shell narrowShell">
        <section className="hero compactHero">
          <div className="eyebrow">QalaHub</div>
          <h1 className="pageTitle">{error ?? 'Загружаем заявку…'}</h1>
        </section>
      </main>
    );
  }

  const canCancel = !['IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(request.status);

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

      {!request.order && pendingOffers.length === 0 && !terminalStatuses.has(request.status) ? (
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
          <input
            value={cancelPhone}
            onChange={(event) => setCancelPhone(event.target.value)}
            placeholder="Телефон из заявки"
            inputMode="tel"
          />
          <button className="secondaryButton" type="button" onClick={() => void cancelRequest()} disabled={actionId !== null}>
            {actionId === 'cancel' ? 'Отменяем…' : 'Отменить заявку'}
          </button>
        </section>
      ) : null}
    </main>
  );
}
