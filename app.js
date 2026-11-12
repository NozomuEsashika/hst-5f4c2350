'use strict';

// 判定の目安: 上り ÷ 予定ビットレート
const RATIO_OK = 2.0;      // これ以上 = OK
const RATIO_WARN = 1.5;    // これ以上 = 注意、未満 = NG
const JITTER_WARN_MS = 30; // ジッターがこれを超えたら注意書きを足す
const RTT_WARN_MS = 100;
const MIN_SEC = 8;         // これより短く終わった測定は参考値扱い
const STORE_KEY = 'haishin-speedtest:log:v1';

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');

let running = false;
let current = null; // 直近の測定結果

// ---------- 予定ビットレート ----------
function plannedMbps() {
  const v = parseFloat($('bitrate').value);
  return Number.isFinite(v) && v > 0 ? v : null;
}
let presetBtn = null; // 押したプリセット(720p/30 と 720p/60 が同じ値なので値では選べない)
document.querySelectorAll('.presets button').forEach((b) => {
  b.addEventListener('click', () => {
    $('bitrate').value = b.dataset.v;
    presetBtn = b;
    markPreset();
    if (current) { current.planned = plannedMbps(); renderVerdict(current); }
  });
});
function markPreset() {
  if (presetBtn && parseFloat(presetBtn.dataset.v) !== plannedMbps()) presetBtn = null;
  if (!presetBtn) presetBtn = [...document.querySelectorAll('.presets button')].find((b) => parseFloat(b.dataset.v) === plannedMbps()) || null;
  document.querySelectorAll('.presets button').forEach((b) => b.classList.toggle('on', b === presetBtn));
}
$('bitrate').addEventListener('input', () => {
  markPreset();
  if (current) { current.planned = plannedMbps(); renderVerdict(current); }
});
markPreset();

// ---------- 開始 ----------
$('go').addEventListener('click', run);

function setStatus(msg, isErr = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('err', isErr);
}

// 対数目盛のバー(1〜1000Mbps)
function setBar(id, mbps) {
  const pct = mbps > 0 ? Math.min(100, Math.max(2, (Math.log10(mbps) / 3) * 100)) : 0;
  $(id).style.width = pct + '%';
}

// 時刻(秒)と累積バイトの列から、約1秒ごとの速度の最低・最高を出す
function rangeFromSeries(series) {
  if (series.length < 2) return { min: NaN, max: NaN };
  const rates = [];
  let a = series[0];
  for (const p of series) {
    if (p.t - a.t >= 1) {
      rates.push(((p.bytes - a.bytes) * 8) / (p.t - a.t) / 1e6);
      a = p;
    }
  }
  if (!rates.length) return { min: NaN, max: NaN };
  return { min: Math.min(...rates), max: Math.max(...rates) };
}

async function run() {
  if (running) return;
  running = true;
  $('go').disabled = true;
  $('save-box').hidden = true;
  current = null;
  renderVerdict(null);
  ['up', 'down'].forEach((k) => { $(k).textContent = '--'; setBar(k + '-bar', 0); });
  ['d-server', 'd-rtt', 'd-jitter', 'd-up-range', 'd-down-range'].forEach((k) => { $(k).textContent = '-'; });
  setStatus('測定サーバーを探しています…');

  const r = {
    at: new Date().toISOString(),
    planned: plannedMbps(),
    server: '', down: NaN, up: NaN, minRttMs: NaN, jitterMs: NaN,
    downMin: NaN, downMax: NaN, upMin: NaN, upMax: NaN,
  };
  const downSeries = [];
  const upClient = [];
  const upServer = [];
  const rtts = [];
  let minRttUs = Infinity;
  const errors = [];

  const onServerTcp = (tcp) => {
    if (!tcp) return;
    if (Number.isFinite(tcp.MinRTT) && tcp.MinRTT > 0) minRttUs = Math.min(minRttUs, tcp.MinRTT);
  };

  try {
    await ndt7.test(
      {
        userAcceptedDataPolicy: true,
        downloadworkerfile: 'vendor/ndt7-download-worker.js',
        uploadworkerfile: 'vendor/ndt7-upload-worker.js',
        metadata: { client_name: 'haishin-speedtest' },
      },
      {
        serverChosen: (s) => {
          const loc = s.location ? [s.location.city, s.location.country].filter(Boolean).join(', ') : '';
          r.server = loc ? `${loc}(${s.machine})` : (s.machine || '');
          $('d-server').textContent = r.server || '-';
          setStatus('下りを測っています…');
        },
        downloadMeasurement: (m) => {
          if (m.Source === 'client') {
            downSeries.push({ t: m.Data.ElapsedTime, bytes: m.Data.NumBytes });
            $('down').textContent = fmt(m.Data.MeanClientMbps);
            setBar('down-bar', m.Data.MeanClientMbps);
          } else if (m.Data && m.Data.TCPInfo) {
            onServerTcp(m.Data.TCPInfo);
            if (Number.isFinite(m.Data.TCPInfo.RTT) && m.Data.TCPInfo.RTT > 0) rtts.push(m.Data.TCPInfo.RTT / 1000);
          }
        },
        downloadComplete: (d) => {
          const c = d && d.LastClientMeasurement;
          if (c) r.down = c.MeanClientMbps;
          setStatus('上りを測っています…');
        },
        uploadMeasurement: (m) => {
          if (m.Source === 'server' && m.Data && m.Data.TCPInfo) {
            const tcp = m.Data.TCPInfo;
            onServerTcp(tcp);
            if (tcp.BytesReceived > 0 && tcp.ElapsedTime > 0) {
              upServer.push({ t: tcp.ElapsedTime / 1e6, bytes: tcp.BytesReceived });
              const mbps = (tcp.BytesReceived * 8) / tcp.ElapsedTime; // bit/µs = Mbps
              $('up').textContent = fmt(mbps);
              setBar('up-bar', mbps);
            }
          } else if (m.Source === 'client') {
            upClient.push({ t: m.Data.ElapsedTime, bytes: m.Data.NumBytes, mbps: m.Data.MeanClientMbps });
            if (!upServer.length) { $('up').textContent = fmt(m.Data.MeanClientMbps); setBar('up-bar', m.Data.MeanClientMbps); }
          }
        },
        uploadComplete: () => {},
        error: (e) => { errors.push(String(e)); },
      },
    );
  } catch (e) {
    errors.push(String(e && e.message ? e.message : e));
  }

  // 上りはサーバー側で受け取った量を優先(送信側は手元のバッファに積んだ分まで数えてしまうため)
  if (upServer.length) {
    const last = upServer[upServer.length - 1];
    r.up = (last.bytes * 8) / (last.t * 1e6);
    const rg = rangeFromSeries(upServer); r.upMin = rg.min; r.upMax = rg.max;
  } else if (upClient.length) {
    r.up = upClient[upClient.length - 1].mbps;
    const rg = rangeFromSeries(upClient); r.upMin = rg.min; r.upMax = rg.max;
  }
  { const rg = rangeFromSeries(downSeries); r.downMin = rg.min; r.downMax = rg.max; }
  // 測定が短すぎる・送信側の値しか無い・途中エラー は「参考値」として結果に残す
  r.cautions = [];
  if (errors.length) r.cautions.push('途中でエラーあり');
  const lastT = (arr) => (arr.length ? arr[arr.length - 1].t : 0);
  if (downSeries.length && lastT(downSeries) < MIN_SEC) r.cautions.push(`下りの測定が${fmt(lastT(downSeries), 0)}秒で終了`);
  const upT = upServer.length ? lastT(upServer) : lastT(upClient);
  if ((upServer.length || upClient.length) && upT < MIN_SEC) r.cautions.push(`上りの測定が${fmt(upT, 0)}秒で終了`);
  if (!upServer.length && upClient.length) r.cautions.push('上りは送信側の値(実際より高めに出ることがある)');
  if (Number.isFinite(minRttUs)) r.minRttMs = minRttUs / 1000;
  if (rtts.length >= 2) {
    let s = 0;
    for (let i = 1; i < rtts.length; i++) s += Math.abs(rtts[i] - rtts[i - 1]);
    r.jitterMs = s / (rtts.length - 1);
  }

  r.planned = plannedMbps();
  running = false;
  $('go').disabled = false;

  // ライブラリはつながらなくても「成功」で終わることがあるので、数字が取れたかで判定する
  const gotUp = Number.isFinite(r.up) && r.up > 0;
  const gotDown = Number.isFinite(r.down) && r.down > 0;
  if (!gotUp && !gotDown) {
    setStatus('測定できませんでした。通信を確認して、もう一度押してください。' + (errors.length ? `(${errors[0]})` : ''), true);
    return;
  }
  if (!gotUp || !gotDown) {
    setStatus(`${gotUp ? '下り' : '上り'}が測れませんでした。結果は参考程度にしてください。` + (errors.length ? `(${errors[0]})` : ''), true);
  } else if (errors.length) {
    setStatus(`測定は終わりましたが、途中でエラーがありました(${errors[0]})`, true);
  } else {
    setStatus('測定が終わりました');
  }

  current = r;
  showResult(r);
  $('save-box').hidden = false;
}

function showResult(r) {
  $('up').textContent = fmt(r.up);
  $('down').textContent = fmt(r.down);
  setBar('up-bar', r.up); setBar('down-bar', r.down);
  $('d-server').textContent = r.server || '取れませんでした';
  $('d-rtt').textContent = Number.isFinite(r.minRttMs) ? `${fmt(r.minRttMs)} ms` : '取れませんでした';
  $('d-jitter').textContent = Number.isFinite(r.jitterMs) ? `${fmt(r.jitterMs)} ms` : '取れませんでした';
  $('d-up-range').textContent = `${fmt(r.upMin)} / ${fmt(r.upMax)} Mbps`;
  $('d-down-range').textContent = `${fmt(r.downMin)} / ${fmt(r.downMax)} Mbps`;
  renderVerdict(r);
}

// ---------- 判定 ----------
function judge(r) {
  if (!r) return { level: 'none', title: '未測定', body: '測定するとここに結果が出ます' };
  if (!Number.isFinite(r.up) || r.up <= 0) return { level: 'ng', title: '判定できません', body: '上りが測れませんでした' };
  if (!r.planned) return { level: 'none', title: 'ビットレート未入力', body: `上り ${fmt(r.up)} Mbps。配信ビットレートを入れると判定します` };
  const ratio = r.up / r.planned;
  const notes = [];
  if (Number.isFinite(r.jitterMs) && r.jitterMs > JITTER_WARN_MS) notes.push(`ジッターが ${fmt(r.jitterMs, 0)}ms と大きめです`);
  if (Number.isFinite(r.minRttMs) && r.minRttMs > RTT_WARN_MS) notes.push(`遅延が ${fmt(r.minRttMs, 0)}ms と大きめです`);
  if (Number.isFinite(r.upMin) && r.upMin < r.planned) notes.push(`上りが一時 ${fmt(r.upMin)} Mbps まで落ちています`);
  if (r.cautions && r.cautions.length) notes.unshift(`参考値です: ${r.cautions.join('、')}`);
  const head = `上りは配信ビットレートの ${ratioText(ratio)} 倍(${fmt(r.up)} / ${fmt(r.planned)} Mbps)`;
  let level, title;
  if (ratio >= RATIO_OK) { level = 'ok'; title = 'OK'; }
  else if (ratio >= RATIO_WARN) { level = 'warn'; title = '注意'; }
  else { level = 'ng'; title = 'NG'; }
  const advice = {
    ok: '',
    warn: '混雑や他の通信で詰まるおそれがあります。ビットレートを下げるか、配信専用の回線を用意してください。',
    ng: 'このままだと映像が止まるおそれがあります。ビットレートを下げるか、配信専用の回線を用意してください。',
  }[level];
  return { level, title, ratio, body: [head, advice, ...notes].filter(Boolean).join('\n') };
}

// 境界の手前が繰り上がって見えないよう切り捨てで2桁
function ratioText(x) { return Number.isFinite(x) ? (Math.floor(x * 100) / 100).toFixed(2) : '-'; }

function renderVerdict(r) {
  const j = judge(r);
  $('verdict').className = 'verdict v-' + j.level;
  $('v-title').textContent = j.title;
  $('v-body').textContent = j.body;
}

// ---------- 履歴 ----------
function loadLog() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) throw new Error('形式が違います');
    const ok = arr.filter(isEntry);
    if (ok.length !== arr.length) {
      // 読めない記録を捨てたまま保存すると元データが消えるので、保存を止めて知らせる
      logBroken = true;
      toast(`読めない記録が ${arr.length - ok.length} 件あります。上書きを防ぐため記録を止めています`, true);
    }
    return ok;
  } catch (e) {
    logBroken = true;
    toast('記録を読み込めませんでした。上書きを防ぐため記録を止めています: ' + e.message, true);
    return [];
  }
}
let logBroken = false;
function isEntry(e) {
  return !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.at === 'string'
    && (e.cautions === undefined || (Array.isArray(e.cautions) && e.cautions.every((c) => typeof c === 'string')));
}
function saveLog(arr) {
  if (logBroken) { toast('記録が壊れているため記録を止めています', true); return false; }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(arr));
    return true;
  } catch (e) {
    toast('記録できませんでした(ブラウザが保存を許していない可能性): ' + e.message, true);
    return false;
  }
}

function dt(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function summaryText(e) {
  const j = judge(e);
  return [
    `【配信回線チェック】${dt(e.at)}`,
    e.place ? `会場: ${e.place}` : '',
    e.line ? `回線: ${e.line}` : '',
    `上り: ${fmt(e.up)} Mbps(最低 ${fmt(e.upMin)} / 最高 ${fmt(e.upMax)})`,
    `下り: ${fmt(e.down)} Mbps(最低 ${fmt(e.downMin)} / 最高 ${fmt(e.downMax)})`,
    `遅延(RTT): ${fmt(e.minRttMs)} ms / ジッター: ${fmt(e.jitterMs)} ms`,
    e.planned ? `配信ビットレート: ${fmt(e.planned)} Mbps → ${j.title}(${ratioText(j.ratio)}倍)` : '配信ビットレート: 未入力',
    e.cautions && e.cautions.length ? `参考値: ${e.cautions.join('、')}` : '',
    `サーバー: ${e.server || '-'}`,
    e.memo ? `メモ: ${e.memo}` : '',
  ].filter(Boolean).join('\n');
}

$('save').addEventListener('click', () => {
  if (!current) return;
  const entry = {
    ...current,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    planned: plannedMbps(),
    place: $('m-place').value.trim(),
    line: $('m-line').value,
    memo: $('m-memo').value.trim(),
  };
  const log = loadLog();
  log.unshift(entry);
  if (saveLog(log)) {
    toast('記録しました');
    $('save-box').hidden = true;
    renderLog();
  }
});

$('copy-now').addEventListener('click', () => {
  if (!current) return;
  copy(summaryText({ ...current, planned: plannedMbps(), place: $('m-place').value.trim(), line: $('m-line').value, memo: $('m-memo').value.trim() }));
});

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('コピーしました');
  } catch (e) {
    // 古いブラウザや http では clipboard API が使えないので選択コピーに切り替える
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand && document.execCommand('copy');
    ta.remove();
    toast(ok ? 'コピーしました' : 'コピーできませんでした', !ok);
  }
}

function renderLog() {
  const log = loadLog();
  const ol = $('log');
  ol.textContent = '';
  $('log-empty').hidden = log.length > 0;
  for (const e of log) {
    const j = judge(e);
    const li = document.createElement('li');
    li.className = 'entry';
    const head = document.createElement('div');
    head.className = 'entry-head';
    const badge = document.createElement('span');
    badge.className = 'badge b-' + j.level;
    badge.textContent = j.title;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = dt(e.at);
    head.append(badge, when);
    const place = document.createElement('div');
    place.className = 'entry-place';
    place.textContent = [e.place || '(会場なし)', e.line].filter(Boolean).join(' / ');
    const nums = document.createElement('div');
    nums.className = 'entry-nums';
    nums.textContent = `上り ${fmt(e.up)} / 下り ${fmt(e.down)} Mbps・遅延 ${fmt(e.minRttMs)}ms・配信 ${e.planned ? fmt(e.planned) : '-'}Mbps`;
    li.append(head, place, nums);
    if (e.cautions && e.cautions.length) {
      const cau = document.createElement('div');
      cau.className = 'entry-caution';
      cau.textContent = '参考値: ' + e.cautions.join('、');
      li.append(cau);
    }
    if (e.memo) {
      const memo = document.createElement('div');
      memo.className = 'entry-memo';
      memo.textContent = e.memo;
      li.append(memo);
    }
    const btns = document.createElement('div');
    btns.className = 'row-btns';
    const c = document.createElement('button');
    c.type = 'button'; c.textContent = 'コピー';
    c.addEventListener('click', () => copy(summaryText(e)));
    const d = document.createElement('button');
    d.type = 'button'; d.textContent = '削除'; d.className = 'danger';
    d.addEventListener('click', () => {
      if (!confirm(`${dt(e.at)} ${e.place || ''} の記録を消します。よろしいですか?`)) return;
      if (saveLog(loadLog().filter((x) => x.id !== e.id))) { toast('削除しました'); renderLog(); }
    });
    const im = document.createElement('button');
    im.type = 'button'; im.textContent = '画像';
    im.addEventListener('click', () => saveImage(e));
    btns.append(c, im, d);
    li.append(btns);
    ol.append(li);
  }
}

$('clear').addEventListener('click', () => {
  const n = loadLog().length;
  if (logBroken) {
    // 壊れた履歴から抜け出す道。読めない中身ごと消す
    if (!confirm('記録のデータが壊れていて読めません。消して作り直しますか? 元に戻せません。')) return;
    try { localStorage.removeItem(STORE_KEY); logBroken = false; toast('記録を作り直しました'); renderLog(); }
    catch (e) { toast('消せませんでした: ' + e.message, true); }
    return;
  }
  if (!n) return;
  if (!confirm(`記録 ${n} 件をすべて削除します。元に戻せません。先に CSV に書き出しましたか?`)) return;
  if (saveLog([])) { toast('すべて削除しました'); renderLog(); }
});

// ---------- 画像 ----------
const IMG_COLOR = { ok: '#74d15d', warn: '#f2c94c', ng: '#ff5c55', none: '#989da7' };
const IMG = { text: '#f7f4ef', muted: '#989da7', faint: '#666c76', accent: '#ff8a32', line: 'rgba(255,255,255,.14)', tile: 'rgba(255,255,255,.06)' };
const IMG_FONT = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif';

// 長い文字列を幅に収める(はみ出す分は … で切る)
// 絵文字などを途中で割らないよう、文字のかたまり単位に分ける
function chars(text) {
  if (window.Intl && Intl.Segmenter) return Array.from(new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(text), (x) => x.segment);
  return Array.from(text);
}
function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  const cs = chars(text);
  while (cs.length > 1 && ctx.measureText(cs.join('') + '…').width > maxW) cs.pop();
  return cs.join('') + '…';
}
// 幅で折り返して最大 maxLines 行まで描く
function wrapText(ctx, text, x, y, maxW, lineH, maxLines) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let cur = '';
    for (const ch of chars(para)) {
      if (ctx.measureText(cur + ch).width > maxW) { lines.push(cur); cur = ch; } else cur += ch;
    }
    lines.push(cur);
  }
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown[maxLines - 1] = fitText(ctx, shown[maxLines - 1] + '…………', maxW);
  shown.forEach((l, i) => ctx.fillText(l, x, y + i * lineH));
  return shown.length;
}

function drawCard(e) {
  const W = 1200, H = 760, P = 56;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const j = judge(e);
  // 背景: ダッシュボードと同じ青チャコール＋右上のオレンジ光
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#182338'); bg.addColorStop(.55, '#0c0f16'); bg.addColorStop(1, '#080a0f');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * .9, 0, 0, W * .9, 0, 520);
  glow.addColorStop(0, 'rgba(242,102,34,.38)'); glow.addColorStop(1, 'rgba(242,102,34,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = IMG.accent; ctx.font = `800 26px ${IMG_FONT}`; ctx.fillText('配信回線チェック', P, 66);
  ctx.fillStyle = IMG.muted; ctx.font = `600 24px ${IMG_FONT}`; ctx.textAlign = 'right'; ctx.fillText(dt(e.at), W - P, 66); ctx.textAlign = 'left';
  ctx.fillStyle = IMG.text; ctx.font = `800 36px ${IMG_FONT}`;
  ctx.fillText(fitText(ctx, [e.place || '(会場なし)', e.line].filter(Boolean).join(' / '), W - P * 2), P, 128);

  // 判定
  ctx.fillStyle = IMG_COLOR[j.level]; ctx.fillRect(P, 162, 8, 96);
  ctx.font = `800 54px ${IMG_FONT}`; ctx.fillText(j.title, P + 28, 214);
  ctx.fillStyle = IMG.muted; ctx.font = `600 26px ${IMG_FONT}`;
  ctx.fillText(!e.planned ? 'ビットレート未入力' : Number.isFinite(j.ratio) ? `上りは配信ビットレート ${fmt(e.planned)} Mbps の ${ratioText(j.ratio)} 倍` : `配信ビットレート ${fmt(e.planned)} Mbps(上りが測れていません)`, P + 28, 250);

  // 上り・下り
  const tile = (x, label, v, range) => {
    ctx.fillStyle = IMG.tile; ctx.strokeStyle = IMG.line; ctx.lineWidth = 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, 290, 536, 180, 18); else ctx.rect(x, 290, 536, 180);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = IMG.muted; ctx.font = `650 24px ${IMG_FONT}`; ctx.fillText(label, x + 26, 332);
    ctx.fillStyle = IMG.text; ctx.font = `800 76px ${IMG_FONT}`; ctx.fillText(fmt(v), x + 26, 414);
    const vw = ctx.measureText(fmt(v)).width;
    ctx.fillStyle = IMG.muted; ctx.font = `650 26px ${IMG_FONT}`; ctx.fillText('Mbps', x + 38 + vw, 414);
    ctx.font = `600 22px ${IMG_FONT}`; ctx.fillText(range, x + 26, 450);
  };
  tile(P, '上り(アップロード)', e.up, `最低 ${fmt(e.upMin)} / 最高 ${fmt(e.upMax)} Mbps`);
  tile(P + 552, '下り(ダウンロード)', e.down, `最低 ${fmt(e.downMin)} / 最高 ${fmt(e.downMax)} Mbps`);

  ctx.fillStyle = IMG.text; ctx.font = `650 26px ${IMG_FONT}`;
  ctx.fillText(`遅延(RTT) ${fmt(e.minRttMs)} ms　ジッター ${fmt(e.jitterMs)} ms`, P, 520);
  ctx.fillStyle = IMG.muted; ctx.font = `600 22px ${IMG_FONT}`;
  ctx.fillText(fitText(ctx, `測定サーバー: ${e.server || '-'}`, W - P * 2), P, 556);
  let y = 600;
  if (e.cautions && e.cautions.length) {
    ctx.fillStyle = IMG_COLOR.warn;
    ctx.fillText(fitText(ctx, '参考値: ' + e.cautions.join('、'), W - P * 2), P, y); y += 38;
  }
  if (e.memo) {
    ctx.fillStyle = IMG.text; ctx.font = `600 24px ${IMG_FONT}`;
    wrapText(ctx, 'メモ: ' + e.memo, P, y, W - P * 2, 34, y > 600 ? 2 : 3);
  }
  ctx.fillStyle = IMG.muted; ctx.font = `600 18px ${IMG_FONT}`; ctx.textAlign = 'right';
  ctx.fillText('測定: M-Lab ndt7 ／ 測った時点・測定サーバーまでの値', W - P, H - 26); ctx.textAlign = 'left';
  return cv;
}

// 押した操作の扱いが切れないよう、共有を呼ぶまでの間に await を挟まない(iPhone Safari 対策)
let imaging = false;
function dataUrlToBlob(url) {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: 'image/png' });
}
async function saveImage(e) {
  if (imaging) return;
  imaging = true;
  try {
    const cv = drawCard(e);
    const url = cv.toDataURL('image/png');
    if (!url.startsWith('data:image/png')) throw new Error('画像を作れませんでした');
    const blob = dataUrlToBlob(url);
    const d = new Date(e.at);
    const p = (n) => String(n).padStart(2, '0');
    const place = chars((e.place || '').replace(/[\\/:*?"<>|\s]+/g, '_')).slice(0, 30).join('');
    const name = `配信回線チェック_${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${place ? '_' + place : ''}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    // iPhone は共有シートから「画像を保存」で写真に入れられる
    let shareFailed = false;
    const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return; }
      catch (err) {
        if (err && err.name === 'AbortError') return; // 自分で閉じただけ
        shareFailed = true;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(shareFailed ? '共有画面を開けなかったので、ダウンロードに切り替えました' : '画像のダウンロードを始めました', shareFailed);
  } catch (err) {
    toast('画像を保存できませんでした: ' + (err && err.message ? err.message : err), true);
  } finally {
    imaging = false;
  }
}

$('img-now').addEventListener('click', () => {
  if (!current) return;
  saveImage({ ...current, planned: plannedMbps(), place: $('m-place').value.trim(), line: $('m-line').value, memo: $('m-memo').value.trim() });
});

// ---------- CSV ----------
function csvCell(v) {
  let s = v == null ? '' : String(v);
  // 表計算ソフトで数式として動かないように頭の記号を無効化する
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
$('csv').addEventListener('click', () => {
  const log = loadLog();
  if (!log.length) { toast('書き出す記録がありません', true); return; }
  const num = (v) => (Number.isFinite(v) ? v.toFixed(1) : '');
  const head = ['日時', '会場', '回線', '配信ビットレート(Mbps)', '判定', '倍率', '上り(Mbps)', '上り最低', '上り最高', '下り(Mbps)', '下り最低', '下り最高', '遅延RTT(ms)', 'ジッター(ms)', 'サーバー', '参考値', 'メモ'];
  const rows = log.map((e) => {
    const j = judge(e);
    return [dt(e.at), e.place, e.line, e.planned ?? '', j.title, Number.isFinite(j.ratio) ? ratioText(j.ratio) : '',
      num(e.up), num(e.upMin), num(e.upMax), num(e.down), num(e.downMin), num(e.downMax),
      num(e.minRttMs), num(e.jitterMs), e.server, (e.cautions || []).join('、'), e.memo];
  });
  const csv = '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  a.href = URL.createObjectURL(blob);
  a.download = `配信回線チェック_${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

// ---------- 通知 ----------
let toastTimer;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 6000 : 2500);
}

renderLog();
