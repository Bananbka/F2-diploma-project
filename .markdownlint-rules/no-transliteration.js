// Docs Quality Gate: forbids Cyrillic transliterations of English IT terms and the em dash.
// Text inside fenced code blocks and inline code spans is not checked.
"use strict";

const FORBIDDEN = [
  ["бекенд", "серверна частина"],
  ["фронтенд", "клієнтська частина"],
  ["ендпоінт", "кінцева точка (endpoint)"],
  ["ендпойнт", "кінцева точка (endpoint)"],
  ["юскейс", "прецедент (use case)"],
  ["свагер", "Swagger"],
  ["джейсон", "JSON"],
  ["маркдаун", "Markdown"],
  ["рест апі", "REST API"],
  ["апішк", "API"],
  ["деплой", "розгортання (deploy)"],
  ["юзер", "користувач"],
  ["фіч", "функція (feature)"],
  ["дебаг", "налагодження (debug)"],
  ["білд", "збірка (build)"],
  ["пайплайн", "конвеєр (pipeline)"],
  ["ретра", "повторна спроба (retry)"],
  ["лімітер", "обмежувач (limiter)"],
  ["роутер", "маршрутизатор (router)"],
  ["хендлер", "обробник (handler)"],
  ["гейткіпер", "контроль якості (gatekeeper)"],
  ["бенчмарк", "еталонне вимірювання (benchmark)"],
  ["бандл", "збірка (bundle)"],
];

const WORD_BEFORE = /[\p{L}\p{N}_]$/u;

module.exports = {
  names: ["ZAL001", "no-transliteration"],
  description: "Cyrillic transliteration of an English IT term or an em dash",
  tags: ["language", "thesis"],
  parser: "none",
  function: function rule(params, onError) {
    let inFence = false;
    params.lines.forEach((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return;
      }
      if (inFence) {
        return;
      }
      const text = line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
      const lower = text.toLowerCase();
      for (const [term, replacement] of FORBIDDEN) {
        let from = 0;
        let at;
        while ((at = lower.indexOf(term, from)) !== -1) {
          if (!WORD_BEFORE.test(lower.slice(0, at))) {
            onError({
              lineNumber: index + 1,
              detail: `"${line.substr(at, term.length)}" – use "${replacement}"`,
              range: [at + 1, term.length],
            });
          }
          from = at + term.length;
        }
      }
      const dash = text.indexOf("—");
      if (dash !== -1) {
        onError({
          lineNumber: index + 1,
          detail: "em dash — is not allowed, use the en dash –",
          range: [dash + 1, 1],
        });
      }
    });
  },
};
