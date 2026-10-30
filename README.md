# Nodul Router для OpenCode

Плагин для [OpenCode](https://opencode.ai) 2.2+. Делает [Nodul Router](https://router.nodul.ru) единственным LLM-провайдером и показывает только модели, доступные вашему ключу.

- Список моделей берётся из `GET /api/v1/models` с вашим ключом. Если ключ ограничен частью моделей в кабинете, OpenCode покажет только эти модели.
- В списке только модели с вызовом инструментов: агенту OpenCode они нужны на каждом шаге.
- Остальные LLM-провайдеры (OpenAI, Anthropic, Copilot, OpenCode Zen и другие) скрыты. Интеграции веб-поиска (Exa, Firecrawl, Parallel, Tavily, TinyFish) остаются.
- Модель по умолчанию — `ru-2/deepseek-v4.1-flash`. Если ключу она недоступна, выбирается первая доступная.
- Список обновляется при запуске, при смене ключа и каждые 10 минут.

## Установка

1. Установите [OpenCode Desktop](https://opencode.ai/download).
2. Установите плагин. На macOS:
   ```bash
   /Applications/OpenCode.app/Contents/Resources/opencode-cli plugin add 'git+https://github.com/nodul-app/nodul.code.plugin.git'
   ```
   Если CLI `opencode` есть в `PATH`, можно короче: `opencode plugin add 'git+https://github.com/nodul-app/nodul.code.plugin.git'`.
3. Перезапустите фоновый сервис и OpenCode:
   ```bash
   /Applications/OpenCode.app/Contents/Resources/opencode-cli service restart
   ```
4. Откройте **Settings → Providers → Nodul Router** и вставьте ключ Router (`sk-nr-…`). Ключ можно создать в кабинете Router.

Вместо ввода в интерфейсе можно задать переменную окружения `NODUL_ROUTER_API_KEY`.

## Обновление

OpenCode раз в сутки проверяет, есть ли новая версия плагина. Чтобы поставить её:

```bash
/Applications/OpenCode.app/Contents/Resources/opencode-cli plugin update
```

## Настройки

Настройки задаются в `~/.config/opencode/opencode.json`, если нужны:

```json
{
  "plugins": [
    {
      "package": "git+https://github.com/nodul-app/nodul.code.plugin.git",
      "options": { "defaultModel": "deepseek/deepseek-v4.1-flash" }
    }
  ]
}
```

| Опция          | По умолчанию                     | Что делает                    |
| -------------- | -------------------------------- | ----------------------------- |
| `defaultModel` | `ru-2/deepseek-v4.1-flash`       | ID модели по умолчанию        |
| `baseURL`      | `https://router.nodul.ru/api/v1` | Адрес API роутера             |

## Что важно знать

- **Цены.** Роутер считает в PnP (1 PnP = 100 ₽). OpenCode показывает эти числа со знаком `$`. Точные расходы смотрите в логах кабинета Router.
- **Лимит ответа — не больше 128 000 токенов.** OpenCode запрашивает у модели весь лимит ответа, а роутер заранее резервирует его стоимость на балансе. Поэтому плагин ограничивает лимит 128 000 токенов, даже если модель умеет больше.
- **Первые секунды после запуска сервиса.** Пока плагин загружается, могут мелькнуть другие провайдеры.
- **Свой `provider` или `model` в `opencode.json`.** Эти настройки применяются после плагина и перекрывают его. Чтобы виден был только Nodul Router, не описывайте в конфиге свой провайдер `nodul` и других провайдеров.

## Если раньше Nodul был настроен вручную

Удалите из `~/.config/opencode/opencode.json` блок `provider.nodul`, а также `model`, `small_model` и `enabled_providers`, если вы их добавляли. Затем уберите переменные фонового сервиса, если задавали их:

```bash
/Applications/OpenCode.app/Contents/Resources/opencode-cli service unset env OPENCODE_MODELS_PATH
```
```bash
/Applications/OpenCode.app/Contents/Resources/opencode-cli service unset env OPENCODE_DISABLE_FREE_MODELS
```

## Не работает

| Симптом                                    | Что делать                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Nodul Router просит войти заново           | Роутер ответил `401`: ключ неверный, отключён или истёк. Введите новый ключ.                                       |
| Нет моделей                                | Проверьте, что ключ введён и что в кабинете ему доступна хотя бы одна модель с возможностью «Инструменты».        |
| Видны другие провайдеры                    | Проверьте `opencode.json`: в нём не должно быть своих `provider`. Перезапустите сервис (`service restart`).        |
| `402` при запросе                          | У плательщика мало средств или исчерпан бюджет ключа.                                                              |

## Разработка

```bash
pnpm install
pnpm run typecheck
pnpm test        # unit-тесты
pnpm run smoke   # настоящий OpenCode + мок-роутер; путь к CLI — OPENCODE_BIN
```

Чтобы проверить локальную копию, укажите в `opencode.json` путь к папке: `"plugins": ["/путь/к/nodul.code.plugin"]`.

CI (`.github/workflows/ci.yml`) запускается на push, на PR и раз в сутки. Он проверяет плагин на свежих `@opencode/plugin` и `@opencode/cli`, чтобы поломку из-за обновления OpenCode было видно раньше, чем коллеги обновятся.
