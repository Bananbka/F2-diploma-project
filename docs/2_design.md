# РОЗДІЛ 2. ПРОЄКТУВАННЯ АРХІТЕКТУРИ СИСТЕМИ

> Розділ реалізує завдання 2–4 проєкту. Етапи 2–4 календарного плану: 19.10.2026 – 28.02.2027. Вимоги, на які посилаються діаграми, наведено в [специфікації вимог (SRS)](srs.md), ключове архітектурне рішення – в [ADR-001](adr/0001-choice-of-technology.md).

## 2.1 Контекстне та контейнерне моделювання системи (C4 Model)

Архітектуру описано за моделлю C4 у нотації Mermaid.js (Diagrams-as-Code): діаграми побудовано як flowchart зі стилями елементів C4 (Person, Software System, Container, Component, Database) і межами систем у вигляді subgraph. Діаграми зберігаються в репозиторії поруч із текстом і рендеряться GitHub.

### 2.1.1 Діаграма контексту (C4 Level 1)

<a id="diagram-level1"></a>

```mermaid
flowchart TB
  user["<b>Користувач</b><br/><i>[Person]</i><br/>Обмінюється повідомленнями<br/>та файлами через браузер"]
  admin["<b>Власник / адміністратор чату</b><br/><i>[Person]</i><br/>Керує складом груп,<br/>публікує в каналах"]
  sys["<b>Mess&Gags</b><br/><i>[Software System]</i><br/>Вебмесенджер з наскрізним шифруванням:<br/>сервер зберігає лише шифротексти"]
  smtp["<b>SMTP-сервер</b><br/><i>[External System]</i><br/>Gmail SMTP, листи з одноразовими кодами"]
  user -- "Реєстрація, повідомлення, вкладення<br/>[HTTPS, WSS]" --> sys
  admin -- "Керування групами, публікації<br/>[HTTPS, WSS]" --> sys
  sys -- "Листи з OTP<br/>[SMTP / STARTTLS :587]" --> smtp
  smtp -. "Доставка листа<br/>[SMTP / IMAP]" .-> user
  classDef person fill:#08427b,stroke:#052e56,color:#ffffff
  classDef system fill:#1168bd,stroke:#0b4884,color:#ffffff
  classDef ext fill:#8a8a8a,stroke:#5e5e5e,color:#ffffff
  class user,admin person
  class sys system
  class smtp ext
```

Рисунок 2.1 – Діаграма контексту системи (C4 Level 1)

| Елемент | Тип | Опис | Вимоги |
|---|---|---|---|
| Користувач | Person | Реєструється, обмінюється повідомленнями та вкладеннями через браузер | [SRS-FUN-01](srs.md#srs-fun-01), [SRS-FUN-18](srs.md#srs-fun-18) |
| Власник / адміністратор чату | Person | Змінює склад групи, публікує в каналах | [SRS-FUN-23](srs.md#srs-fun-23), [SRS-FUN-24](srs.md#srs-fun-24) |
| Mess&Gags | Software System | Вебмесенджер з наскрізним шифруванням; сервер зберігає лише шифротексти | [SRS, розділ 1](srs.md#1-system-context-контекст-системи) |
| SMTP-сервер | External System | Доставляє листи з одноразовими кодами підтвердження | [SRS-FUN-02](srs.md#srs-fun-02) |

| Зв’язок | Протокол | Призначення |
|---|---|---|
| Користувач → Mess&Gags | HTTPS, WSS | REST-запити та двобічний канал подій |
| Власник / адміністратор → Mess&Gags | HTTPS, WSS | Керування групами, публікації в каналах |
| Mess&Gags → SMTP-сервер | SMTP / STARTTLS, порт 587 | Надсилання OTP |
| SMTP-сервер → Користувач | SMTP / IMAP | Доставка листа до поштової скриньки |

### 2.1.2 Діаграма контейнерів (C4 Level 2)

<a id="diagram-level2"></a>

```mermaid
flowchart TB
  user["<b>Користувач</b><br/><i>[Person]</i><br/>Браузер"]
  smtp["<b>SMTP-сервер</b><br/><i>[External System]</i><br/>Gmail SMTP"]
  subgraph ns ["Mess&Gags"]
    spa["<b>Web Client</b><br/><i>[Container: Angular 19, Web Crypto API]</i><br/>UI та E2EE: ключі пристрою,<br/>шифрування, перевірка member_set_hash"]
    gw["<b>Gateway</b><br/><i>[Container: Nginx]</i><br/>Єдина точка входу: маршрутизація,<br/>rate limiting, security headers, TLS 1.3 (To-Be)"]
    static["<b>Static Server</b><br/><i>[Container: Nginx]</i><br/>Віддає збірку SPA"]
    api["<b>API</b><br/><i>[Container: Python 3.12, FastAPI]</i><br/>REST і WebSocket: users, crypto,<br/>chats, messages, files"]
    beat["<b>Celery Beat</b><br/><i>[Container: Python, Celery]</i><br/>Планувальник щодобових задач"]
    worker["<b>Celery Worker</b><br/><i>[Container: Python, Celery]</i><br/>Листи, ротація епох,<br/>очищення грантів і об'єктів"]
    pg[("<b>PostgreSQL 17</b><br/><i>[Реляційна СУБД]</i><br/>Користувачі, пристрої, чати,<br/>епохи, гранти, аудит")]
    mongo[("<b>MongoDB 8</b><br/><i>[Документна СУБД]</i><br/>Зашифровані конверти")]
    redis[("<b>Redis 8</b><br/><i>[In-memory, AOF]</i><br/>Pub/sub, присутність, ліміти,<br/>denylist, брокер Celery")]
    s3[("<b>RustFS</b><br/><i>[S3-сумісне сховище]</i><br/>Зашифровані вкладення,<br/>аватари, стікери")]
  end
  user -- "Працює з інтерфейсом" --> spa
  spa -- "REST, події<br/>[HTTPS, WSS]" --> gw
  gw -- "Файли SPA<br/>[HTTP]" --> static
  gw -- "/api, /ws<br/>[HTTP/1.1, WebSocket]" --> api
  gw -- "/objects<br/>[HTTP, S3 API]" --> s3
  api -- "Транзакції<br/>[SQL / TCP :5432]" --> pg
  api -- "Конверти<br/>[MongoDB Wire :27017]" --> mongo
  api -- "PUBLISH, ліміти, задачі<br/>[RESP :6379]" --> redis
  api -- "Шифротексти<br/>[S3 API :9000]" --> s3
  beat -- "Задачі за розкладом<br/>[RESP :6379]" --> redis
  redis -- "Задачі<br/>[RESP :6379]" --> worker
  worker -- "Ротація епох<br/>[SQL / TCP :5432]" --> pg
  worker -- "Посилання на об'єкти<br/>[MongoDB Wire]" --> mongo
  worker -- "Видалення об'єктів<br/>[S3 API]" --> s3
  worker -- "Листи з OTP<br/>[SMTP / STARTTLS :587]" --> smtp
  classDef person fill:#08427b,stroke:#052e56,color:#ffffff
  classDef cont fill:#438dd5,stroke:#2e6295,color:#ffffff
  classDef db fill:#2f6fb0,stroke:#1f4f80,color:#ffffff
  classDef ext fill:#8a8a8a,stroke:#5e5e5e,color:#ffffff
  class user person
  class spa,gw,static,api,beat,worker cont
  class pg,mongo,redis,s3 db
  class smtp ext
  style ns fill:none,stroke:#888888,stroke-dasharray:6 4
```

Рисунок 2.2 – Діаграма контейнерів системи (C4 Level 2)

Назовні опубліковано лише контейнер Gateway; СУБД, Redis і API доступні тільки у внутрішній мережі Docker Compose.

| Контейнер | Технологія | Відповідальність | Вимоги |
|---|---|---|---|
| Web Client | Angular 19, Web Crypto API | Інтерфейс; генерація ключів пристрою, шифрування повідомлень і вкладень, перевірка `member_set_hash`, safety number | [SRS-FUN-06](srs.md#srs-fun-06), [SRS-FUN-07](srs.md#srs-fun-07), [SRS-FUN-14](srs.md#srs-fun-14), [SRS-FUN-15](srs.md#srs-fun-15), [SRS-FUN-25](srs.md#srs-fun-25), [SRS-FUN-26](srs.md#srs-fun-26) |
| Gateway | Nginx | Єдина точка входу, маршрутизація `/api`, `/ws`, `/objects`, rate limiting, security headers, ліміт тіла запиту, TLS 1.3 (To-Be) | [SRS-NFR-SEC-02](srs.md#srs-nfr-sec-02) – [SRS-NFR-SEC-05](srs.md#srs-nfr-sec-05) |
| Static Server | Nginx | Віддає зібраний SPA | – |
| API | Python 3.12, FastAPI, Uvicorn | REST і WebSocket; домени `users`, `crypto`, `chats`, `messages`, `files`; перевірка епохи й підпису конвертів | [SRS-FUN-01](srs.md#srs-fun-01) – [SRS-FUN-04](srs.md#srs-fun-04), [SRS-FUN-08](srs.md#srs-fun-08) – [SRS-FUN-11](srs.md#srs-fun-11), [SRS-FUN-16](srs.md#srs-fun-16) – [SRS-FUN-24](srs.md#srs-fun-24), [SRS-FUN-27](srs.md#srs-fun-27), [SRS-FUN-28](srs.md#srs-fun-28) |
| Celery Worker | Python, Celery | Надсилання листів, ротація епох, очищення грантів, журналу аудиту та осиротілих об’єктів | [SRS-FUN-02](srs.md#srs-fun-02), [SRS-FUN-12](srs.md#srs-fun-12), [SRS-FUN-13](srs.md#srs-fun-13), [SRS-NFR-COMP-02](srs.md#srs-nfr-comp-02) |
| Celery Beat | Python, Celery | Планувальник щодобових задач | [SRS-FUN-12](srs.md#srs-fun-12) |
| PostgreSQL 17 | Реляційна СУБД | Користувачі, пристрої, чати, учасники, епохи, розподіли ключів, гранти, журнал аудиту (ACID-транзакції для атомарної ротації) | [SRS-FUN-11](srs.md#srs-fun-11) |
| MongoDB 8 | Документна СУБД | Незмінні зашифровані конверти повідомлень | [SRS-FUN-18](srs.md#srs-fun-18) |
| Redis 8 | In-memory, AOF | Pub/sub подій, присутність, лічильники rate limiting, denylist токенів, брокер Celery; персональні черги Redis Streams (To-Be) | [SRS-FUN-04](srs.md#srs-fun-04), [SRS-FUN-19](srs.md#srs-fun-19), [SRS-NFR-SEC-03](srs.md#srs-nfr-sec-03) |
| RustFS | S3-сумісне сховище | Шифротексти вкладень, аватари, стікери | [SRS-FUN-27](srs.md#srs-fun-27) |

| Зв’язок | Протокол | Призначення |
|---|---|---|
| Web Client → Gateway | HTTPS, WSS | REST-запити та події реального часу |
| Gateway → Static Server | HTTP | Статичні файли SPA |
| Gateway → API | HTTP/1.1, WebSocket | Проксіювання `/api` і `/ws` |
| Gateway → RustFS | HTTP, S3 API | Публічні об’єкти (`/objects`) |
| API → PostgreSQL | SQL / TCP 5432 (asyncpg) | Транзакції епох, чатів, ключів |
| API → MongoDB | MongoDB Wire Protocol / TCP 27017 (Motor) | Запис і читання конвертів |
| API → Redis | RESP / TCP 6379 | `PUBLISH` подій, лічильники, denylist, постановка задач Celery |
| API → RustFS | S3 API / HTTP 9000 (aiobotocore) | Збереження шифротекстів вкладень |
| Celery Beat → Redis | RESP / TCP 6379 | Публікація задач за розкладом |
| Celery Worker → Redis | RESP / TCP 6379 | Отримання задач |
| Celery Worker → PostgreSQL, MongoDB, RustFS | SQL / TCP, MongoDB Wire / TCP, S3 API / HTTP | Ротація епох, очищення грантів і об’єктів |
| Celery Worker → SMTP-сервер | SMTP / STARTTLS, порт 587 | Надсилання OTP |

## 2.2 Компонентне моделювання критичного сервісу системи

Для декомпозиції обрано контейнер **API** (FastAPI), оскільки в ньому зосереджено перевірку інваріантів E2EE на сервері: строгої епохи, підпису конверта та прав учасника. Діаграма відображає шлях надсилання зашифрованого повідомлення.

<a id="diagram-level3"></a>

```mermaid
flowchart TB
  gw["<b>Gateway</b><br/><i>[Container: Nginx]</i>"]
  subgraph apiB ["API [Container: FastAPI]"]
    subgraph inb ["Вхідний шар"]
      mw["<b>Request Logging Middleware</b><br/><i>[loguru]</i><br/>Журнал з маскуванням токенів"]
      router["<b>Messages Router</b><br/><i>[APIRouter]</i><br/>POST /messages"]
      wsend["<b>WebSocket Endpoint</b><br/><i>[FastAPI WebSocket]</i><br/>/ws: підписка, typing, presence"]
    end
    subgraph guard ["Захисний шар"]
      dto["<b>DTO Validation</b><br/><i>[Pydantic v2]</i><br/>Схеми, кадр ≤ 64 КБ"]
      auth["<b>Auth Guard</b><br/><i>[Depends]</i><br/>JWT, denylist"]
      rl["<b>Rate Limiter</b><br/><i>[Depends]</i><br/>Fixed window, fail-closed"]
      err["<b>Exception Handlers</b><br/><i>[FastAPI]</i><br/>Єдиний формат помилок"]
    end
    subgraph core ["Бізнес-логіка"]
      msvc["<b>Message Service</b><br/><i>[send_message]</i><br/>Сценарій надсилання"]
      policy["<b>Chat Access Policy</b><br/><i>[role_rank]</i><br/>Участь у чаті, RBAC"]
      envv["<b>Envelope Validator</b><br/><i>[_validate_envelope]</i><br/>Строга епоха, підпис Ed25519"]
      esvc["<b>Epoch Service</b><br/><i>[epoch_service]</i><br/>Епохи, розподіли ключів"]
      pub["<b>Event Publisher</b><br/><i>[Порт, Protocol]</i><br/>Абстракція розсилання"]
    end
    subgraph data ["Шар даних (адаптери)"]
      mrepo["<b>Message Repository</b><br/><i>[Motor]</i>"]
      erepo["<b>Crypto Repository</b><br/><i>[SQLAlchemy AsyncSession]</i>"]
      redispub["<b>Redis Event Publisher</b><br/><i>[redis.asyncio]</i><br/>PUBLISH, Streams (To-Be)"]
      sec["<b>Security Store</b><br/><i>[redis.asyncio]</i><br/>Лічильники лімітів, denylist"]
    end
  end
  pg[("<b>PostgreSQL 17</b>")]
  mongo[("<b>MongoDB 8</b>")]
  redis[("<b>Redis 8</b>")]
  gw -- "[HTTP/1.1]" --> mw
  gw -- "[WebSocket]" --> wsend
  mw -- "ASGI" --> router
  router -- "Depends" --> dto
  router -- "Depends" --> auth
  router -- "Depends" --> rl
  wsend -- "Depends" --> auth
  router -. "AppException" .-> err
  router -- "виклик" --> msvc
  msvc -- "виклик" --> policy
  msvc -- "виклик" --> envv
  envv -- "виклик" --> esvc
  msvc -- "порт" --> pub
  msvc -- "інтерфейс" --> mrepo
  esvc -- "інтерфейс" --> erepo
  pub -. "реалізація (DI)" .-> redispub
  auth -- "GET denylist" --> sec
  rl -- "INCR, EXPIRE" --> sec
  mrepo -- "[MongoDB Wire / TCP]" --> mongo
  erepo -- "[SQL / TCP]" --> pg
  redispub -- "PUBLISH [RESP]" --> redis
  sec -- "[RESP / TCP]" --> redis
  wsend -. "SUBSCRIBE [RESP]" .-> redis
  classDef comp fill:#85bbf0,stroke:#5d82a8,color:#0b1f33
  classDef cont fill:#438dd5,stroke:#2e6295,color:#ffffff
  classDef db fill:#2f6fb0,stroke:#1f4f80,color:#ffffff
  class mw,router,wsend,dto,auth,rl,err,msvc,policy,envv,esvc,pub,mrepo,erepo,redispub,sec comp
  class gw cont
  class pg,mongo,redis db
  style apiB fill:none,stroke:#888888,stroke-dasharray:6 4
  style inb fill:none,stroke:#aaaaaa
  style guard fill:none,stroke:#aaaaaa
  style core fill:none,stroke:#aaaaaa
  style data fill:none,stroke:#aaaaaa
```

Рисунок 2.3 – Діаграма компонентів контейнера API (C4 Level 3)

| Шар | Компонент | Відповідальність | Взаємодія | Вимоги |
|---|---|---|---|---|
| Наскрізний | Request Logging Middleware | Журнал запитів з маскуванням токенів у шляху | ASGI-конвеєр | [SRS-NFR-OBS-01](srs.md#srs-nfr-obs-01), [SRS-NFR-COMP-02](srs.md#srs-nfr-comp-02) |
| Вхідний | Messages Router | Кінцеві точки REST для повідомлень | Отримує залежності через `Depends`, викликає Message Service | [SRS-FUN-18](srs.md#srs-fun-18) |
| Вхідний | WebSocket Endpoint | Підключення, підписка на персональний канал, typing, presence | `Depends(get_ws_current_user)`, `SUBSCRIBE` у Redis | [SRS-FUN-18](srs.md#srs-fun-18), [SRS-NFR-SEC-04](srs.md#srs-nfr-sec-04) |
| Вхідний | DTO Validation | Валідація тіла запиту схемами Pydantic, ліміт кадру 64 КБ | Автоматично до виклику обробника | [SRS-NFR-SEC-04](srs.md#srs-nfr-sec-04) |
| Захисний | Auth Guard | Перевірка JWT з cookie та denylist | `Depends`, читання через Security Store | [SRS-FUN-03](srs.md#srs-fun-03), [SRS-FUN-04](srs.md#srs-fun-04) |
| Захисний | Rate Limiter | Fixed window, fail-closed | `Depends`, `INCR` / `EXPIRE` через Security Store | [SRS-NFR-SEC-03](srs.md#srs-nfr-sec-03) |
| Захисний | Exception Handlers | Перетворення `AppException`, `RequestValidationError` і необроблених винятків у єдиний формат відповіді | Обробники винятків FastAPI | – |
| Бізнес-логіка | Message Service | Сценарій надсилання: перевірка доступу, валідація конверта, збереження, публікація події | Інтерфейсні виклики портів | [SRS-FUN-18](srs.md#srs-fun-18) |
| Бізнес-логіка | Chat Access Policy | Участь у чаті, ранги ролей OWNER/ADMIN/MEMBER | Виклик функції | [SRS-FUN-23](srs.md#srs-fun-23), [SRS-FUN-24](srs.md#srs-fun-24) |
| Бізнес-логіка | Envelope Validator | Строга рівність епохи, наявність sender key, підпис Ed25519 | Виклик функції | [SRS-FUN-16](srs.md#srs-fun-16), [SRS-FUN-17](srs.md#srs-fun-17), [ADR-001](adr/0001-choice-of-technology.md) |
| Бізнес-логіка | Epoch Service | Поточна епоха, розподіли ключів, ротація | Через Crypto Repository | [SRS-FUN-11](srs.md#srs-fun-11), [ADR-001](adr/0001-choice-of-technology.md) |
| Бізнес-логіка | Event Publisher (порт) | Абстракція розсилання подій, від якої залежить Message Service | Protocol, реалізація через DI | [SRS-FUN-18](srs.md#srs-fun-18), [SRS-FUN-19](srs.md#srs-fun-19) |
| Дані | Message Repository | Збереження та читання конвертів | Motor → MongoDB | [SRS-FUN-18](srs.md#srs-fun-18) |
| Дані | Crypto Repository | Епохи, розподіли, гранти | SQLAlchemy AsyncSession → PostgreSQL | [SRS-FUN-11](srs.md#srs-fun-11) |
| Дані | Redis Event Publisher | Реалізація порту: `PUBLISH user:{id}`, у To-Be – `XADD` у Redis Streams | redis.asyncio → Redis | [SRS-FUN-19](srs.md#srs-fun-19) |
| Дані | Security Store | Лічильники rate limiting і denylist токенів | redis.asyncio → Redis | [SRS-FUN-04](srs.md#srs-fun-04), [SRS-NFR-SEC-03](srs.md#srs-nfr-sec-03) |

Залежності спрямовані від вхідного шару до бізнес-логіки, а від бізнес-логіки – до портів. Реалізації портів (репозиторії, Redis Event Publisher) підставляються механізмом `Depends`, тому сервіси не залежать від драйверів СУБД. Розподіл на порти Message Repository, Crypto Repository та Event Publisher є цільовою структурою: у поточному коді сервіси використовують `AsyncSession` і колекції Motor безпосередньо, а розсилання подій виконує функція `_broadcast` у модулі маршрутизатора (router). Перенесення розсилання в Event Publisher виконується разом із реалізацією черги Redis Streams ([SRS-FUN-19](srs.md#srs-fun-19)).

## 2.3 Документування архітектурних рішень (Architecture Decision Records)

Архітектурні рішення фіксуються у форматі ADR за шаблоном Майкла Нігардза в каталозі [adr/](adr/).

| ADR | Рішення | Статус |
|---|---|---|
| [ADR-001](adr/0001-choice-of-technology.md) | Вибір схеми групового наскрізного шифрування: sender-key ratchet з явною моделлю епох замість попарних сесій Double Ratchet, класичних Sender Keys і MLS | Approved |

## 2.4 Обґрунтування архітектурного стилю та технологічного стеку

## 2.5 UML-моделі взаємодії

### 2.5.1 Реєстрація пристрою та публікація ключів

### 2.5.2 Ротація епохи групових ключів

## 2.6 Схеми даних

### 2.6.1 Реляційна схема PostgreSQL

### 2.6.2 Документна модель MongoDB

## 2.7 Алгоритми критичних вузлів системи

## Висновки до розділу 2
