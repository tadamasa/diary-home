# DayReaders(「その日」を読む共通ライブラリ)

「その日の縁泉・読み終えた本・観た映画・月の印・日記」を読む Apps Script ライブラリです。読むだけで、どのシートにも書きません。
もとは日記ハブ(`hub/Code.gs`)・縁泉ハブ(tadamasa/ensen-home の `hub/Code.gs`)・日記v2(`diary_gas_v2/コード.js`)に同じ読み方が3つ書かれていたのを、ここ1か所にまとめました。

## いまの版

| 項目 | 値 |
|---|---|
| ライブラリ名(プロジェクト名) | DayReaders |
| 識別子(呼ぶ側で使う名前) | `DayReaders` |
| スクリプトID | `1AERbCrDNFVHKT1YDCTSensHNs4X8QrACyaS-p3xDFhqrUq2r7NGMuMwk` |
| 版数 | 1(2026-11-02 公開) |

使う側は、版を固定して追加します(「開発モード」は使わない)。ライブラリを直したら新しい版を作り、使う側を1つずつその版に上げます。

| 使う側 | 使う関数 | 追加した版 |
|---|---|---|
| 日記ハブ(この repo の `hub/Code.gs`) | ensenForDate, booksForDate, filmsForDate, monthMarks | 1(hub/appsscript.json に記載) |
| 縁泉ハブ(tadamasa/ensen-home) | diaryForDate, booksForDate, filmsForDate, monthMarks | 1(2026-11-02、ensen-home PR #2) |

## 関数

シートIDとアプリのURLは引数で渡します。ライブラリの中では PropertiesService を読みません(呼ぶ側のスクリプト プロパティで決めて渡す)。
どれも例外を投げず、読めないときは `{ ok: false, error }` を返します。

| 関数 | 返すもの |
|---|---|
| `booksForDate(booksSheetId, 'YYYY-MM-DD', appUrl)` | `{ ok, books: [{ id, title, author, category, cover, note, url }] }`。note はその本の最初のメモ、url は `appUrl#book/ID` |
| `filmsForDate(moviesSheetId, 'YYYY-MM-DD', appUrl)` | `{ ok, films: [{ filmId, title, place, venue, score, text, year, directors, poster, genres, url }] }`。place は 配信/映画館/テレビ/ディスク/その他、genres は先頭2つを「・」でつなぐ、url は `appUrl#film/ID` |
| `monthMarks(booksSheetId, moviesSheetId, 'YYYY-MM')` | `{ ok, month, books: [日付], films: [日付] }`。片方が読めないときは `booksError` / `filmsError` |
| `ensenForDate(ensenSheetId, 'YYYY-MM-DD')` | `{ ok, events: [{ time, place, type, name, verb, note, media, source }], homeMoves: [{ time, kind }], traces: [{ id, time, place, thumb, promoted }] }` |
| `diaryForDate(diarySheetId, 'YYYY-MM-DD', appUrl)` | `{ ok, url, entries: [{ time, text, feelings, thinkings }] }`。url は `appUrl#day/日付` |

返す形は、置き換え前の日記ハブと縁泉ハブが返していた形を合わせたもの(和集合)です。縁泉ハブにとっては books の id・category・note、films の genres、日記の thinkings が増えるだけで、今の画面はそのまま動きます。
日記ハブの `uiUrl`(縁泉の画面のURL)はライブラリでは返さず、日記ハブが足します。

## 読む約束(列は見出しで引く)

列は位置で決め打ちせず、各シートの1行目の見出しから列番号を引きます。列が足されたり並びが変わっても読めます。
必要な見出しが無いときは、黙って違う列を読まずに `{ ok: false, error: 'books の見出しに finishedAt がありません' }` のように返します。

2026-11-02 に本物のシートで確かめた見出しです(**太字**がこのライブラリの読む列)。この名前を変えると、ここと使う側3つに響きます。

| シート | 見出し |
|---|---|
| 読書ハブ `books` | **id**, rev, mtime, **deleted**, **title**, **author**, **status**, **category**, score, **finishedAt**, **json**(cover) |
| 読書ハブ `notes` | id, rev, mtime, **deleted**, date, **bookId**, bookTitle, kind, **text**, quote, json |
| 映画ハブ `views` | id, rev, mtime, **deleted**, **date**, **filmId**, **filmTitle**, **place**, **venue**, **score**, **text**, json |
| 映画ハブ `films` | **id**, rev, mtime, deleted, **title**, **year**, **directors**, status, lastSeen, seenCount, category, tmdbId, **json**(posterPath, genres) |
| 縁泉 `events` | event_id, **ts**, recorded_ts, lat, lng, **place_name**, **actant_type**, **actant_name**, actant_id, **verb**, **note**, **media_ref**, star, **source**, **tags**(自宅・出発), **enrich**(trace_id) |
| 縁泉 `traces` | **trace_id**, **ts**, recorded_ts, lat, lng, **place_name**, photo_key, source, **thumb_b64** |
| 日記の記録 `CoreData` | **Date**, **Time**, **Text**, **Feelings**, **Thinkings**, Id |

決めごと: 読了は status が「読了」で finishedAt がその日。観た映画は views の date がその日(年だけ・月だけの思い出し記録は入らない)。deleted が true の行は読まない。縁泉の tags に「自宅」を含む行は縁ではなく家の出入り(「出発」を含めば出発、ほかは到着)。

### これで直った不具合

映画ハブの `films` は 2026 年秋に lastSeen・seenCount・category が足されて13列になり、json は13列目に移っていました。置き換え前の日記ハブと縁泉ハブは10列目を json として読んでいたため、「この日に観た映画」にポスターとジャンルが出ていませんでした。見出しで引くようにしたので出ます。

## 公開する(最初の1回、パソコンで)

1. https://script.google.com で「新しいプロジェクト」を作り、名前を **DayReaders** にします。
2. 最初からある `コード.gs` の中身を全部消して、[DayReaders.gs](https://raw.githubusercontent.com/tadamasa/diary-home/main/lib/day-readers/DayReaders.gs) の中身を貼り、保存します。
3. 右上の「デプロイ」→「新しいデプロイ」→ 種類の歯車から「ライブラリ」を選び、説明に「v1」と書いて「デプロイ」。これで版 1 ができます。
4. 左の歯車「プロジェクトの設定」→「スクリプト ID」をコピーします。この README の「いまの版」の表に、スクリプトIDと版数を書きます(Claude に伝えれば書きます)。

ライブラリは自分のアカウントのものなので、共有の設定は要りません(使う側も同じアカウントで動いているため)。

## 使う側に追加する(日記ハブの例)

1. 日記ハブのエディタを開き、左の「ライブラリ」の **+** を押します。
2. スクリプトIDを貼って「検索」、バージョンは **1**(数字を選ぶ。「HEAD(開発モード)」は選ばない)、ID は **DayReaders** のまま「追加」。
3. `コード.gs` を新しい [hub/Code.gs](https://raw.githubusercontent.com/tadamasa/diary-home/main/hub/Code.gs) に貼り替えて保存します。
4. 関数の選択欄で `setup` を選んで「実行」。権限の確認が出たら許可します(ライブラリの中で縁泉・読書ハブ・映画ハブのシートを `SpreadsheetApp.openById` で開くため、初めてのときに聞かれることがあります。今までと同じ「スプレッドシート」の権限です)。
5. 「デプロイ」→「デプロイを管理」→ 鉛筆 → バージョン「新バージョン」→「デプロイ」。URLと合言葉は変わりません。

順番を逆にして、ライブラリを追加する前に新しい Code.gs を貼っても、同期は今まで通り動きます。「その日」の縁泉・本・映画・月の印だけが「ライブラリ DayReaders が追加されていません」という理由つきで空になります。

## ライブラリを直すとき

1. DayReaders.gs を直し、`npm test` を通します(`tests/day-readers.test.mjs` がこのライブラリを Node の vm で動かします)。
2. DayReaders のエディタに貼って保存し、「デプロイ」→「デプロイを管理」→ 鉛筆 → バージョン「新バージョン」。版数が1つ上がります。
3. 使う側のエディタで、左の「ライブラリ」の DayReaders を開いて版を上げ、それぞれ「新バージョン」で出し直します。上の表の「追加した版」も直します。

## 速さについて

Apps Script のライブラリは、呼ぶ側の実行のたびにライブラリのコードを読み込むぶん、少し遅くなります。Google の案内(https://developers.google.com/apps-script/guides/libraries)にも「ライブラリを使うスクリプトは、すべてのコードが1つのプロジェクトにある場合ほど速くは動かない」という注意があります。
このライブラリは1ファイルで依存もないので、増えるのは1回の呼び出しにつき数十〜数百ミリ秒ほどの見込みです(実測はまだ)。読むシートと回数は置き換え前と同じです(json の大きい films と traces は、当日の行だけを読む)。
日記の「その日」が目に見えて遅くなったら教えてください。そのときは日記ハブだけライブラリをやめて DayReaders.gs をハブにそのまま同梱する、という戻し方ができます(関数の中身は同じなので)。
