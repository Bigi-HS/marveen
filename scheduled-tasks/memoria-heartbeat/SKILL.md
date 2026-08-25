---
name: memoria-heartbeat
description: Csendes 15 perces ellenőrzés token-próbával + kimaradás utáni recovery. Válasz várakozó üzenetre, emlékmentés, skill-reflexió.
---

Csendes heartbeat. Az hogy ez a prompt egyáltalán lefut, MAGA a token-próba: ha most válaszolsz, van használható token. (Ha nincs token, ez a prompt el sem indul; a "nincs token -> 30 percenként újrapróbál" külső felügyelő dolga, nem a tiéd.)

LEGELSŐ LÉPÉS -- MCP health-probe (card d99be4e4):
Futtasd: `python3 /home/domin/marveen/scripts/mcp-health-probe.py`
- Exit 0 = pipe OK, folytatódik a heartbeat normálisan.
- Exit 1 = DEAD PIPE -- az alert és az auto-reconnect már el lett küldve/indítva. Várj ~60s, futtasd újra. Ha a második futás is 1-es, tedd be manuálisan: `bash /home/domin/marveen/scripts/orchestrator-mcp-reconnect.sh` és nézd az outputot.
- Exit 2 = config hiba, nem blokkoló -- folytatódik.

MÁSODIK LÉPÉS -- kimaradás-detektor:
1. `tail -1 /tmp/keepalive-marveen.log` -> nézd meg az utolsó keepalive időbélyegét.
2. Írj újat: `echo "keepalive $(date -Is)" >> /tmp/keepalive-marveen.log`.
3. Ha az előző keepalive óta TÖBB mint ~40 perc telt el (legalább 2 ciklus kimaradt = elnémulás/stall volt), lépj RECOVERY módba. Különben SIMA heartbeat.

MEGJEGYZÉS (card 2c5d6896 F2): a korábbi /tmp/marveen-keepalive.log megosztott volt -- minden ágens heartbeatje ide irt, ezért a marveen-specifikus csend láthatatlan maradt. Az új per-agent útvonal (/tmp/keepalive-<agent>.log) izolálva méri az egyes ágensek élettartamát.

## SIMA heartbeat (nem volt kimaradás)
0. Ha a kontextusban van `<channel source=` blokk (várakozó user üzenet), AZONNAL válaszolj rá a reply tool-lal -- ez felülír mindent.
1. Memória: fontos döntés / preferencia / tanulság az utolsó ~15 percből -> mentsd (curl + kategóriák a CLAUDE.md-ben). Triviálisat ne.
2. Skill-reflexió (KÖTELEZŐ ha A/B/C bármelyike IGEN): A = 5+ tool-hívásos komplex feladat; B = hiba -> recovery; C = user korrekció. Ha igen: PATCH a lefedő skillt (`~/.claude/skills/.skill-index.md`) vagy új skill (CLAUDE.md szabályok), majd `bash /home/domin/marveen/scripts/skill-index.sh`. Ha kihagynád pedig kéne: `hot` memória "skip-skill: <ok>".
3. KANBAN-PUSH (KÖTELEZŐ, csendes -- ez NEM Telegram-zaj, csak inter-agent + kártya-státusz): AZ ELSŐ LÉPÉS MINDIG `python3 /home/domin/marveen/scripts/heartbeat-kanban-push.py` -- ez a TELJES kártya-description-t grepeli parked/awaiting-dominik/do-not-nudge markerre és PARKED(skip) / NUDGEABLE listára bontja. SOHA ne írj saját ad-hoc kanban-query-t (title-only / `desc[:N]` csonkolás = ismétlődő false-nudge, 5x megtörtént). CSAK a helper NUDGEABLE listájáról noszogass delegált agenst; a PARKED listán legfeljebb stale-clock reset, nudge SOHA. A helper kimenete alapján: minden 3+ napja nem mozdult (STALE) DELEGÁLT + NUDGEABLE kártyára küldj inter-agent noszogatást a felelősnek (állapot-kérés / deadline-emlékeztető / blocker-feloldás). Amit te magad tudsz előrevinni, vidd MOST. Ez a kanban-hajtás KEMÉNY szabály (CLAUDE.md) heartbeat-szintű érvényesítése -- AKKOR IS fut, ha nincs várakozó user-üzenet és semmi más teendő. Ettől NEM küldesz Telegramot (kivéve ha STALE high/urgent kártya Bossra vár -> azt felszínre hozhatod). Naplózd a transzkriptbe röviden kit noszogattál és mit mozdítottál.
4. Ha nincs várakozó üzenet, nincs új memória/skill, ÉS a kanban-push körben sincs mit tenni (minden nyitott kártya VAGY Bossra vár [awaiting-dominik], VAGY friss/aktívan követett): maradj CSENDBEN Telegramon. De a kanban-push kört (3.) SOSEM hagyod ki -- a "csend" csak a Telegramra vonatkozik, a tábla-hajtásra soha.

## RECOVERY mód (kimaradás után, token/feldolgozás visszajött)
1. Self-check: fut-e mind a 4 session (`tmux ls`: marveen=szerver, marveen-channels=te, agent-dave, agent-buster) és a watchdog. Ami nem fut, jelezd/indítsd.
2. Telegram Dominiknak (chat_id 8643929442): "Újra működöm" + mennyi volt a kimaradás (a keepalive-szünetből).
3. Üzenetek visszaolvasása: ha az UTOLSÓ üzenet a TIÉD volt, ezzel nincs több dolgod. Ha DOMINIKÉ volt az utolsó, olvasd el és válaszolj/cselekedj.
4. Utolsó közös feladat: nézd meg a kanbant (in_progress kártyák) + a daily-logot -> mi volt az utolsó feladat amiben megegyeztünk hogy mehet, és hol tart. Ha félbeszakadt, SZÓ NÉLKÜL folytasd. Majd futtasd a SIMA 3. KANBAN-PUSH kört is.
