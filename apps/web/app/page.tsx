const categories = [
  'Сантехник',
  'Электрик',
  'Автоэлектрик / СТО',
  'Ремонт техники',
  'Клининг',
];

export default function HomePage() {
  return (
    <main className="shell">
      <section className="hero">
        <div className="eyebrow">QalaHub · пилот</div>
        <h1>Скажите, что нужно сделать. Мы найдём того, кто готов взяться.</h1>
        <p className="lead">
          Не каталог телефонов и не лента откликов. Система автоматически ищет доступных
          исполнителей, запускает каскад запросов и возвращает подтверждённые предложения.
        </p>

        <form className="requestBox">
          <label htmlFor="task">Что случилось или что нужно сделать?</label>
          <div className="requestRow">
            <input
              id="task"
              name="task"
              placeholder="Например: протекает кран, нужен сантехник сегодня"
              disabled
            />
            <button type="button" disabled>
              Найти исполнителя
            </button>
          </div>
          <small>Форма станет активной после подключения API заявок.</small>
        </form>
      </section>

      <section className="section">
        <h2>Первые категории</h2>
        <div className="categoryGrid">
          {categories.map((category) => (
            <article className="categoryCard" key={category}>
              <span>{category}</span>
              <strong>Автоподбор</strong>
            </article>
          ))}
        </div>
      </section>

      <section className="section automation">
        <div>
          <div className="eyebrow">Automation first</div>
          <h2>Администратор не должен распределять обычные заказы вручную</h2>
        </div>
        <ol>
          <li>Фильтруем по услуге и городу.</li>
          <li>Оставляем только AVAILABLE.</li>
          <li>Ранжируем по надёжности, скорости, расстоянию и загрузке.</li>
          <li>Отправляем первую волну.</li>
          <li>По таймауту автоматически отправляем следующую.</li>
          <li>После исчерпания вариантов автоматически расширяем поиск.</li>
          <li>Человеку передаются только исключения, которые система не решила сама.</li>
        </ol>
      </section>
    </main>
  );
}
