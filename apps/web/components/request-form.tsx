'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';

type Service = {
  id: string;
  slug: string;
  name: string;
};

type Category = {
  id: string;
  slug: string;
  name: string;
  services: Service[];
};

type CatalogResponse = {
  city: { slug: string; name: string };
  categories: Category[];
};

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1';

export function RequestForm() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [categorySlug, setCategorySlug] = useState('');
  const [serviceSlug, setServiceSlug] = useState('');
  const [phone, setPhone] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [urgency, setUrgency] = useState('TODAY');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`${apiBase}/catalog/pavlodar`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json() as Promise<CatalogResponse>;
      })
      .then((data) => {
        if (cancelled) return;
        setCatalog(data);
        const firstCategory = data.categories[0];
        if (firstCategory) {
          setCategorySlug(firstCategory.slug);
          setServiceSlug(firstCategory.services[0]?.slug ?? '');
        }
      })
      .catch(() => {
        if (!cancelled) setError('Не удалось загрузить список услуг. Проверьте доступность API.');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const selectedCategory = useMemo(
    () => catalog?.categories.find((category) => category.slug === categorySlug) ?? null,
    [catalog, categorySlug],
  );

  function changeCategory(nextSlug: string) {
    setCategorySlug(nextSlug);
    const nextCategory = catalog?.categories.find((category) => category.slug === nextSlug);
    setServiceSlug(nextCategory?.services[0]?.slug ?? '');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const response = await fetch(`${apiBase}/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customerPhone: phone.trim(),
          citySlug: 'pavlodar',
          categorySlug,
          serviceSlug: serviceSlug || undefined,
          title: title.trim(),
          description: description.trim() || undefined,
          urgency,
          maxDistanceKm: 10,
        }),
      });

      const text = await response.text();
      const body = text ? JSON.parse(text) : null;
      if (!response.ok) {
        throw new Error(body?.message ?? 'Не удалось создать заявку');
      }
      if (!body?.requestId || !body?.accessToken) {
        throw new Error('API не вернул защищённый доступ к заявке');
      }

      localStorage.setItem(`qalahub:request:${body.requestId}:token`, body.accessToken);
      window.location.assign(`/request/${body.requestId}`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Не удалось создать заявку');
      setLoading(false);
    }
  }

  return (
    <form className="requestBox" onSubmit={submit}>
      <div className="formHeading">
        <div>
          <strong>Создать заявку</strong>
          <span>Павлодар · автоматический подбор</span>
        </div>
        <span className="liveBadge">Без диспетчера</span>
      </div>

      <div className="formGrid">
        <label>
          <span>Телефон</span>
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="+7 7xx xxx xx xx"
            inputMode="tel"
            autoComplete="tel"
            required
          />
        </label>

        <label>
          <span>Категория</span>
          <select
            value={categorySlug}
            onChange={(event) => changeCategory(event.target.value)}
            disabled={!catalog}
            required
          >
            {(catalog?.categories ?? []).map((category) => (
              <option key={category.id} value={category.slug}>
                {category.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Услуга</span>
          <select
            value={serviceSlug}
            onChange={(event) => setServiceSlug(event.target.value)}
            disabled={!selectedCategory}
          >
            {(selectedCategory?.services ?? []).map((service) => (
              <option key={service.id} value={service.slug}>
                {service.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Когда нужно</span>
          <select value={urgency} onChange={(event) => setUrgency(event.target.value)}>
            <option value="NOW">Сейчас</option>
            <option value="TODAY">Сегодня</option>
            <option value="FLEXIBLE">Можно договориться</option>
          </select>
        </label>
      </div>

      <label className="wideField">
        <span>Что нужно сделать?</span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Например: течёт смеситель на кухне"
          required
          minLength={3}
        />
      </label>

      <label className="wideField">
        <span>Подробности</span>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Опишите проблему, удобное время и важные детали"
          rows={3}
        />
      </label>

      {error ? <div className="formError">{error}</div> : null}

      <div className="formActions">
        <button className="primaryButton" type="submit" disabled={loading || !catalog}>
          {loading ? 'Запускаем поиск…' : 'Найти исполнителя'}
        </button>
        <small>Заявка сразу поступит доступным исполнителям. Ручное подтверждение администратора не требуется.</small>
      </div>
    </form>
  );
}
