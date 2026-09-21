{
        host: ExtVideoService.kinogo,
        url: "stub",
        match: [
            /^([a-z]{2}\.)?kinogo\.(ec|biz)$/,
            /^(www\.)?kinogo\.(ec|biz)$/,
            /^(api\.)?ortified\.ws$/,
            /^(www\.)?cinemar\.cc$/,
            /^[^.]+\.sevstar[^.]*\.(com|cc|net)$/,
        ],
        // «Плеер 3» (sevstar) ПОКА НЕ ПОДДЕРЖАН — см. KINOGO-PATCH.md, раздел
        // «Отложено». Его контейнеры — `hdvbplayer` / `div#player-<hash>`;
        // добавить их сюда можно одной строкой, но нужен полный E2E
        // (в этом фрейме крутится ещё и рекламное <video>, которое надо
        // отсечь), иначе расширение зацепится за рекламу.
        selector: "#player, .player, .venom",
        needExtraData: true,
    },