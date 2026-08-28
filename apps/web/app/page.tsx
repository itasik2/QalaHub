import { RequestForm } from '../components/request-form';

const categories = [
  ['Сантехника', 'Протечки, смесители, трубы'],
  ['Электрика', 'Розетки, проводка, аварии'],
  ['Автоэлектрика / СТО', 'Диагностика и ремонт'],
  ['Ремонт техники', 'Бытовая техника на дому'],
  ['Клининг', 'Уборка квартир и помещений'],
] as const;

export default function HomePage() {
  return (
    <main className="shell">
      <nav className="topbar">
        <a className="brand" href="/">QalaHub</a>
        <div className="topbarActions">
          <span>Павлодар · пилот</span>
          <a className="secondaryButton smallButton" href="/provider">Я исполнитель</a>
        </div>
      </nav>

      <section className="hero">
        <div className="eyebrow">Городские услуги без диспетчера</div>
        <h1>Опишите задачу. QalaHub найдёт того, кто готов взяться.</h1>
        <p className="lead">
          Не нужно обзванивать каталог и ждать десятки откликов. Система сама проверяет
          доступность исполнителей, отправляет запросы волнами и показывает реальные предложения.
        </p>

        <RequestForm />
      </section>

      <section className="section">
        <div className="sectionHeader">
          <div>
            <div className="eyebrow">Пилотные направления</div>
            <h2>С чего начинаем</h2>
          </div>
          <span className="mutedText">Категории загружаются из API при создании заявки</span>
        </div>
        <div className="categoryGrid">
          {categories.map(([category, description]) => (
            <article className="categoryCard" key={category}>
              <span>{category}</span>
              <p>{description}</p>
              <strong>Автоподбор</strong>
            </article>
          ))}
        </div>
      </section>

      <section className="section automation">
        <div>
          <div className="eyebrow">Как это работает</div>
          <h2>Обычный заказ проходит без ручного распределения</h2>
        </div>
        <ol>
          <li>Заявка сразу попадает в matching.</li>
          <li>Остаются только активные и доступные исполнители нужной услуги.</li>
          <li>Система ранжирует их по расстоянию, надёжности, скорости ответа и загрузке.</li>
          <li>Запросы отправляются небольшими волнами, чтобы не спамить весь город.</li>
          <li>Исполнитель принимает задачу и указывает цену и время прибытия.</li>
          <li>Заказчик выбирает предложение, после чего создаётся заказ.</li>
          <li>Администратору остаются только исключения, которые нельзя решить правилами.</li>
        </ol>
      </section>

      <section className="section providerCta">
        <div>
          <div className="eyebrow">Для исполнителей</div>
          <h2>Получайте только те заявки, которые подходят вам сейчас</h2>
          <p className="lead smallLead">
            Выберите услуги, радиус работы и включите доступность. QalaHub сам решит, когда имеет
            смысл отправить вам новый заказ.
          </p>
        </div>
        <a className="primaryButton buttonLink" href="/provider">Подключиться как исполнитель</a>
      </section>
    </main>
  );
}
