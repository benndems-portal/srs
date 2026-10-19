// SRS Card Terminal — the whole raffle table on an iPhone: the Sell page and Staff page (web views of
// the website) plus a Stripe Reader M2 for cards. Slips print on the laptop running /print.
//
// How cards work: the Sell page (on this phone or on a laptop) creates a card charge on the server. This
// app checks in with the server every second (/api/terminal), picks the charge up, collects the card on
// the M2 and lets Stripe confirm it. The server double-checks with Stripe and then creates the sale; the
// Sell page sends the slip to the print station and the buyer gets a text. Card details never touch the website.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Linking, Pressable, SafeAreaView, ScrollView, StyleSheet, Switch, Text, TextInput, View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import {
  StripeTerminalProvider, useStripeTerminal, type Reader, type StripeError,
} from '@stripe/stripe-terminal-react-native';

/* ---------------- Settings ---------------- */
type Settings = { siteUrl: string; password: string; name: string; simulated: boolean; deviceId: string; lastReader: string };
const SETTINGS_KEY = 'srs-terminal-settings';
const APP_VERSION = '1.1.1';
const blank: Settings = { siteUrl: 'https://', password: '', name: '', simulated: false, deviceId: '', lastReader: '' };

async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    const s = { ...blank, ...(raw ? JSON.parse(raw) : {}) };
    if (!s.deviceId) s.deviceId = 'ph-' + Math.random().toString(36).slice(2, 10);
    return s;
  } catch { return { ...blank, deviceId: 'ph-' + Math.random().toString(36).slice(2, 10) }; }
}
const saveSettings = (s: Settings) => AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(s)).catch(() => {});

// Settings live outside React too, so the SDK's token provider can read them.
let current: Settings = blank;

async function server<T = any>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const base = current.siteUrl.replace(/\/+$/, '');
  const res = await fetch(base + '/api/terminal', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-password': current.password },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json().catch(() => ({ error: `Server error ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data as T;
}

const fetchConnectionToken = async () => (await server<{ secret: string }>('connectionToken')).secret;

/* ---------------- Root ---------------- */
export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => { loadSettings().then((s) => { current = s; setSettings(s); setEditing(!s.password || s.siteUrl.length < 12); }); }, []);

  if (!settings) return <Centered><ActivityIndicator color="#f2c14e" /></Centered>;
  if (editing) {
    return (
      <SettingsScreen
        initial={settings}
        onSave={(s) => { current = s; saveSettings(s); setSettings(s); setEditing(false); }}
      />
    );
  }
  return (
    <StripeTerminalProvider tokenProvider={fetchConnectionToken} logLevel="none">
      <TerminalScreen settings={settings} onSettings={() => setEditing(true)} onRemember={(patch) => { const s = { ...settings, ...patch }; current = s; saveSettings(s); setSettings(s); }} />
    </StripeTerminalProvider>
  );
}

/* ---------------- Settings screen ---------------- */
function SettingsScreen({ initial, onSave }: { initial: Settings; onSave: (s: Settings) => void }) {
  const [s, set] = useState<Settings>(initial);
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    const before = current;
    current = { ...s, siteUrl: s.siteUrl.trim() };
    try {
      const c = await server<{ mode: string; title: string }>('config');
      Alert.alert('Connected', `${c.title}\nStripe ${c.mode === 'live' ? 'LIVE' : 'TEST'} mode`);
    } catch (e: any) { Alert.alert('Could not connect', e.message); }
    finally { current = before; setTesting(false); }
  };
  return (
    <SafeAreaView style={st.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={{ padding: 20 }} keyboardShouldPersistTaps="handled">
        <Text style={st.h1}>Card terminal setup</Text>
        <Text style={st.label}>Website address</Text>
        <TextInput style={st.input} value={s.siteUrl} onChangeText={(v) => set({ ...s, siteUrl: v })} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://your-site.netlify.app" placeholderTextColor="#6d7699" />
        <Text style={st.label}>Staff password</Text>
        <TextInput style={st.input} value={s.password} onChangeText={(v) => set({ ...s, password: v })} secureTextEntry autoCapitalize="none" placeholder="Same as the staff page" placeholderTextColor="#6d7699" />
        <Text style={st.label}>Name for this terminal</Text>
        <TextInput style={st.input} value={s.name} onChangeText={(v) => set({ ...s, name: v })} placeholder="e.g. Table 1 – Jon's iPhone" placeholderTextColor="#6d7699" />
        <View style={[st.row, { marginTop: 18 }]}>
          <View style={{ flex: 1 }}>
            <Text style={st.text}>Simulated reader</Text>
            <Text style={st.dim}>For testing with a Stripe test key, no real reader needed.</Text>
          </View>
          <Switch value={s.simulated} onValueChange={(v) => set({ ...s, simulated: v })} />
        </View>
        <Btn label={testing ? 'Checking…' : 'Test connection'} kind="ghost" onPress={test} disabled={testing} />
        <Btn label="Save" onPress={() => {
          if (!/^https?:\/\/.+\..+/.test(s.siteUrl.trim())) return Alert.alert('Enter the website address, e.g. https://your-site.netlify.app');
          if (!s.password) return Alert.alert('Enter the staff password.');
          onSave({ ...s, siteUrl: s.siteUrl.trim(), name: s.name.trim() || 'Card terminal' });
        }} />
        <Text style={[st.dim, { marginTop: 24 }]}>Version {APP_VERSION}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

/* ---------------- Terminal screen ---------------- */
type Charge = { id: string; status: string; amount: number; clientSecret: string; name: string; count: number; title: string; error?: string };
type Phase = 'idle' | 'collecting' | 'processing' | 'declined' | 'approved' | 'error';
type Tab = 'sell' | 'staff' | 'reader';

const MESSAGES: Record<string, string> = {
  insertCard: 'Insert card', insertOrSwipeCard: 'Insert or swipe card', multipleContactlessCardsDetected: 'More than one card detected — tap just one',
  removeCard: 'Remove card', retryCard: 'Try the card again', swipeCard: 'Swipe card', tryAnotherCard: 'Try another card',
  tryAnotherReadMethod: 'Try another way (insert, swipe or tap)', checkMobileDevice: 'Check your phone to finish paying', cardRemovedTooEarly: 'Card removed too early — try again',
};

function TerminalScreen({ settings, onSettings, onRemember }: { settings: Settings; onSettings: () => void; onRemember: (p: Partial<Settings>) => void }) {
  useKeepAwake();
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState('');
  const [locationId, setLocationId] = useState('');
  const [mode, setMode] = useState('');
  const [title, setTitle] = useState('');
  const [found, setFound] = useState<Reader.Type[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [battery, setBattery] = useState<number | null>(null);
  const [update, setUpdate] = useState('');
  const [charge, setCharge] = useState<Charge | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [readerMsg, setReaderMsg] = useState('');
  const [note, setNote] = useState('');
  const [online, setOnline] = useState(true);
  const chargeRef = useRef<Charge | null>(null);
  const busy = useRef(false); // a card collection is running
  const canceledRemotely = useRef(false);
  const [tab, setTab] = useState<Tab>('sell');
  const sellView = useRef<WebView>(null);
  const staffView = useRef<WebView>(null);

  const sdk = useStripeTerminal({
    onUpdateDiscoveredReaders: (readers) => setFound(readers),
    onFinishDiscoveringReaders: (err) => { setScanning(false); if (err && err.code !== 'CANCELED') setProblem(err.message); },
    onDidRequestReaderDisplayMessage: (m) => setReaderMsg(MESSAGES[m] || String(m)),
    onDidRequestReaderInput: (opts) => setReaderMsg(opts.includes('tapCard') ? 'Tap, insert or swipe' : 'Insert or swipe'),
    onDidReportReaderSoftwareUpdateProgress: (p) => setUpdate(`Updating reader… ${Math.round(Number(p) * 100)}%`),
    onDidFinishInstallingUpdate: () => setUpdate(''),
    onDidUpdateBatteryLevel: (b) => setBattery(b.batteryLevel),
    onDidReportLowBatteryWarning: () => setNote('Reader battery is low — plug it in soon.'),
    onDidDisconnect: () => { setBattery(null); setNote('Reader disconnected.'); },
    onDidStartReaderReconnect: () => setNote('Reconnecting to the reader…'),
    onDidSucceedReaderReconnect: () => setNote(''),
  });
  const { connectedReader } = sdk;

  // 1. Start the SDK and get the Stripe location for Bluetooth readers.
  useEffect(() => {
    (async () => {
      try {
        await Location.requestForegroundPermissionsAsync().catch(() => null);
        const cfg = await server<{ locationId: string; mode: string; title: string }>('config');
        setLocationId(cfg.locationId); setMode(cfg.mode); setTitle(cfg.title);
        const { error } = await sdk.initialize();
        if (error) throw new Error(error.message);
        setReady(true);
      } catch (e: any) { setProblem(e.message || String(e)); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2. Find readers. Reconnects automatically to the reader used last time.
  const scan = useCallback(async () => {
    setProblem(''); setFound([]); setScanning(true);
    const { error } = await sdk.discoverReaders({ discoveryMethod: 'bluetoothScan', simulated: settings.simulated, timeout: 60 });
    if (error && error.code !== 'CANCELED') setProblem(error.message);
    setScanning(false);
  }, [sdk, settings.simulated]);

  useEffect(() => { if (ready && !connectedReader) scan(); /* eslint-disable-next-line */ }, [ready]);

  const connect = useCallback(async (reader: Reader.Type) => {
    setConnecting(true); setProblem('');
    const { reader: r, error } = await sdk.connectReader({ discoveryMethod: 'bluetoothScan', reader, locationId, autoReconnectOnUnexpectedDisconnect: true });
    setConnecting(false);
    if (error) { setProblem(error.message); return; }
    setBattery(r?.batteryLevel ?? null);
    onRemember({ lastReader: reader.serialNumber });
    setNote('');
  }, [sdk, locationId, onRemember]);

  useEffect(() => {
    if (connectedReader || connecting || !found.length) return;
    const last = found.find((r) => r.serialNumber === settings.lastReader) || (settings.simulated ? found[0] : undefined);
    if (last) { sdk.cancelDiscovering().catch(() => {}); connect(last); }
  }, [found, connectedReader, connecting, settings.lastReader, settings.simulated, connect, sdk]);

  // 3. Check in with the server every second; take a charge when one is waiting.
  useEffect(() => {
    if (!ready) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        if (busy.current && chargeRef.current) {
          // While collecting, watch for the laptop canceling.
          const { request } = await server<{ request: Charge }>('status', { id: chargeRef.current.id });
          if (request && ['canceled', 'expired', 'failed', 'succeeded'].includes(request.status)) {
            canceledRemotely.current = request.status !== 'succeeded';
            if (phase === 'collecting') await sdk.cancelCollectPaymentMethod().catch(() => {});
            else if (phase === 'declined' || phase === 'error') await finish(request.status === 'succeeded' ? 'succeeded' : 'canceled');
          }
        } else if (connectedReader && phase !== 'approved') {
          const reader = connectedReader;
          const { request } = await server<{ request: Charge | null }>('poll', {
            terminal: { id: settings.deviceId, name: settings.name, reader: `${reader.deviceType} ${reader.serialNumber}`.trim(), battery: battery ?? reader.batteryLevel ?? null, app: APP_VERSION },
          });
          if (request && request.status === 'processing' && !busy.current) takeCharge(request);
        }
        setOnline(true);
      } catch { setOnline(false); }
      if (!stop) setTimeout(tick, 1000);
    };
    tick();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, connectedReader, phase, battery]);

  // 4. Collect the card and let Stripe confirm it.
  const takeCharge = async (c: Charge) => {
    busy.current = true; canceledRemotely.current = false;
    chargeRef.current = c; setCharge(c); setPhase('collecting'); setReaderMsg('Tap, insert or swipe'); setNote('');
    const ev = (kind: string, message = '') => server('event', { id: c.id, terminal: { id: settings.deviceId }, kind, message }).catch(() => {});
    ev('collecting');
    try {
      const got = await sdk.retrievePaymentIntent(c.clientSecret);
      if (got.error) throw got.error;
      const collected = await sdk.collectPaymentMethod({ paymentIntent: got.paymentIntent, skipTipping: true });
      if (collected.error) throw collected.error;
      setPhase('processing'); setReaderMsg(''); ev('processing');
      const confirmed = await sdk.confirmPaymentIntent({ paymentIntent: collected.paymentIntent });
      if (confirmed.error) throw confirmed.error;
      await finish('succeeded');
    } catch (e: any) {
      const err = e as StripeError;
      if (err?.code === 'CANCELED' || canceledRemotely.current) {
        await finish('canceled');
      } else if (['DECLINED_BY_STRIPE_API', 'DECLINED_BY_READER'].includes(String(err?.code)) || /declin/i.test(err?.message || '')) {
        // Same charge, another card: stay on it until the buyer tries again or someone cancels.
        setPhase('declined'); setReaderMsg(''); setNote(err.message || 'Card declined');
        ev('declined', err.message || 'Card declined');
        busy.current = true;
      } else {
        setPhase('error'); setNote(err?.message || String(e));
        ev('declined', err?.message || 'Card error');
      }
    }
  };

  const finish = async (status: 'succeeded' | 'canceled' | 'failed', error = '') => {
    const c = chargeRef.current;
    if (!c) return;
    let finalStatus = status;
    try {
      const { request } = await server<{ request: Charge }>('result', { id: c.id, terminal: { id: settings.deviceId }, status, error });
      finalStatus = request?.status as any;
    } catch (e: any) { setNote('Could not reach the website: ' + e.message + '. The Sell page will check with Stripe on its own.'); }
    busy.current = false;
    if (finalStatus === 'succeeded') {
      setPhase('approved'); setReaderMsg('');
      setTimeout(() => { chargeRef.current = null; setCharge(null); setPhase('idle'); }, 2000);
    } else {
      chargeRef.current = null; setCharge(null); setPhase('idle'); setReaderMsg('');
      if (status === 'canceled') setNote(canceledRemotely.current ? 'Canceled on the Sell page.' : 'Payment canceled.');
    }
  };

  const tryAgain = () => { const c = chargeRef.current; if (c) { busy.current = false; takeCharge(c); } };
  const cancelHere = async () => {
    if (phase === 'collecting') { await sdk.cancelCollectPaymentMethod().catch(() => {}); return; } // the catch above reports it
    await finish('canceled');
  };

  /* ---------- Web pages (Sell + Staff) ---------- */
  const base = settings.siteUrl.replace(/\/+$/, '');
  const readerLabel = connectedReader ? `Reader ${connectedReader.serialNumber}${battery != null ? ` · ${Math.round(battery * 100)}%` : ''}` : '';
  // Signs the page in with the staff password and tells /sell which phone it's on, so its card charges come here.
  const boot = `(function(){try{sessionStorage.setItem('auctionPw',${JSON.stringify(settings.password)});}catch(e){}
    window.SRS_APP=${JSON.stringify({ terminalId: settings.deviceId, terminalName: settings.name, app: APP_VERSION })};
    window.SRS_APP.readerReady=${connectedReader ? 'true' : 'false'};})();true;`;
  useEffect(() => {
    const js = `window.SRS_APP&&(window.SRS_APP.readerReady=${connectedReader ? 'true' : 'false'});window.srsSetReader&&window.srsSetReader(${connectedReader ? 'true' : 'false'},${JSON.stringify(readerLabel)});true;`;
    sellView.current?.injectJavaScript(js);
  }, [connectedReader, readerLabel]);

  const onMessage = (e: { nativeEvent: { data: string } }) => {
    try { const m = JSON.parse(e.nativeEvent.data); if (m.type === 'openReader') setTab('reader'); } catch {}
  };
  // Links off the website (and "open in new tab" links) go to Safari.
  const sameSite = (url: string) => url.startsWith(base) || url.startsWith('about:') || url.startsWith('blob:') || url.startsWith('data:');
  const web = (path: string, ref: React.RefObject<WebView | null>, visible: boolean) => (
    <WebView
      ref={ref as any}
      source={{ uri: base + path }}
      style={st.web}
      // The library wraps the page in its own flex:1 box, so hide that box, or a hidden tab still takes half the screen.
      containerStyle={visible ? st.webBox : st.hidden}
      injectedJavaScriptBeforeContentLoaded={boot}
      onMessage={onMessage}
      onShouldStartLoadWithRequest={(r) => { if (sameSite(r.url)) return true; Linking.openURL(r.url).catch(() => {}); return false; }}
      onOpenWindow={(e) => { const u = e.nativeEvent.targetUrl; if (sameSite(u)) ref.current?.injectJavaScript(`location.href=${JSON.stringify(u)};true;`); else Linking.openURL(u).catch(() => {}); }}
      pullToRefreshEnabled
      allowsBackForwardNavigationGestures={false}
      keyboardDisplayRequiresUserAction={false}
      hideKeyboardAccessoryView={false}
      decelerationRate="normal"
      setSupportMultipleWindows={false}
      startInLoadingState
      renderLoading={() => <View style={st.webCover}><ActivityIndicator color="#f2c14e" /></View>}
      renderError={(_d, _c, desc) => (
        <View style={[st.webCover, { padding: 20 }]}><Text style={st.problem}>Couldn't load {base + path}{'\n'}{desc}</Text><Btn label="Try again" kind="ghost" onPress={() => ref.current?.reload()} /></View>
      )}
    />
  );

  /* ---------- UI ---------- */
  const money = (n: number) => '$' + Number(n || 0).toFixed(Number(n) % 1 ? 2 : 0);
  const readerPane = connectedReader ? (
    <View style={st.card}>
      <Text style={st.ready}>Reader ready</Text>
      <Text style={st.text}>Cards from the Sell tab (and any laptop that sends cards to “{settings.name}”) come to this reader.</Text>
      <Text style={[st.dim, { marginTop: 14, textAlign: 'center' }]}>{readerLabel}</Text>
      {update ? <Text style={st.note}>{update}</Text> : null}
      {note ? <Text style={st.note}>{note}</Text> : null}
      <Btn label="Back to selling" onPress={() => setTab('sell')} />
      <Btn label="Disconnect reader" kind="ghost" onPress={() => sdk.disconnectReader()} />
    </View>
  ) : (
    <View style={st.card}>
      <Text style={st.h2}>Connect the card reader</Text>
      <Text style={st.text}>Turn on the Stripe Reader M2 (press the button until the lights blink) and keep it near this phone.</Text>
      {!ready && !problem ? <ActivityIndicator color="#f2c14e" style={{ marginTop: 16 }} /> : null}
      {connecting ? <Text style={st.note}>Connecting… the first time this can take a few minutes while the reader updates.</Text> : null}
      {update ? <Text style={st.note}>{update}</Text> : null}
      {note ? <Text style={st.note}>{note}</Text> : null}
      {found.map((r) => (
        <Pressable key={r.serialNumber} style={st.readerRow} onPress={() => connect(r)} disabled={connecting}>
          <Text style={st.text}>{r.label || r.deviceType} · {r.serialNumber}</Text>
          <Text style={st.link}>Connect</Text>
        </Pressable>
      ))}
      {ready && <Btn label={scanning ? 'Looking for readers…' : 'Search for readers'} kind="ghost" onPress={scan} disabled={scanning || connecting} />}
      <Text style={[st.dim, { marginTop: 14, textAlign: 'center' }]}>You can sell cash and check without the reader.</Text>
    </View>
  );

  return (
    <SafeAreaView style={st.screen}>
      <StatusBar style="light" />
      <View style={st.top}>
        <Pressable style={[st.pill, connectedReader ? st.pillOk : st.pillBad]} onPress={() => setTab('reader')} hitSlop={8}>
          <Text style={[st.pillText, { color: connectedReader ? '#39d98a' : '#ff5a6a' }]} numberOfLines={1}>
            ● {connectedReader ? `Card reader${battery != null ? ` ${Math.round(battery * 100)}%` : ''}` : 'Reader not connected'}
          </Text>
        </Pressable>
        <Text style={[st.dim, { flex: 1, marginLeft: 10 }]} numberOfLines={1}>{settings.name}{mode === 'test' ? ' · TEST' : ''}{online ? '' : ' · offline'}</Text>
        <Pressable onPress={onSettings} hitSlop={12} disabled={!!charge}><Text style={[st.link, charge && { opacity: 0.3 }]}>Settings</Text></Pressable>
      </View>
      {mode === 'test' && <Text style={st.testBanner}>STRIPE TEST MODE — no real money moves</Text>}

      <View style={{ flex: 1 }}>
        {/* Both pages stay loaded so switching tabs never loses a sale in progress. */}
        {web('/sell', sellView, tab === 'sell')}
        {web('/admin', staffView, tab === 'staff')}
        {tab === 'reader' && <ScrollView contentContainerStyle={st.body}>{readerPane}{problem ? <Text style={st.problem}>{problem}</Text> : null}</ScrollView>}

        {charge && (
          <View style={st.overlay}>
            <View style={[st.card, phase === 'approved' && st.cardOk, phase === 'declined' && st.cardBad]}>
              <Text style={st.amount}>{money(charge.amount)}</Text>
              <Text style={st.buyer}>{charge.name} · {charge.count} ticket{charge.count === 1 ? '' : 's'}</Text>
              {phase === 'collecting' && <><ActivityIndicator color="#f2c14e" style={{ marginTop: 18 }} /><Text style={st.big}>{readerMsg || 'Tap, insert or swipe'}</Text><Text style={st.text}>Hand the reader to the buyer.</Text></>}
              {phase === 'processing' && <><ActivityIndicator color="#6fa8ff" style={{ marginTop: 18 }} /><Text style={st.big}>Approving…</Text>{readerMsg ? <Text style={st.text}>{readerMsg}</Text> : null}</>}
              {phase === 'approved' && <Text style={[st.big, { color: '#39d98a' }]}>Approved ✓</Text>}
              {phase === 'declined' && <><Text style={[st.big, { color: '#ff5a6a' }]}>Declined</Text><Text style={st.text}>{note}</Text><Btn label="Try another card" onPress={tryAgain} /></>}
              {phase === 'error' && <><Text style={[st.big, { color: '#ff5a6a' }]}>Problem</Text><Text style={st.text}>{note}</Text><Btn label="Try again" onPress={tryAgain} /></>}
              {phase !== 'approved' && phase !== 'processing' && <Btn label="Cancel payment" kind="danger" onPress={cancelHere} />}
            </View>
          </View>
        )}
      </View>

      <View style={st.tabs}>
        {([['sell', 'Sell'], ['staff', 'Staff'], ['reader', 'Card reader']] as [Tab, string][]).map(([k, label]) => (
          <Pressable key={k} style={st.tab} onPress={() => setTab(k)}>
            <Text style={[st.tabText, tab === k && st.tabOn]}>{label}</Text>
            {k === 'reader' && !connectedReader ? <View style={st.badge} /> : null}
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

/* ---------------- Bits ---------------- */
function Btn({ label, onPress, kind = 'gold', disabled }: { label: string; onPress: () => void; kind?: 'gold' | 'ghost' | 'danger'; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={({ pressed }) => [st.btn, kind === 'ghost' && st.btnGhost, kind === 'danger' && st.btnDanger, (pressed || disabled) && { opacity: 0.6 }]}>
      <Text style={[st.btnText, kind !== 'gold' && { color: kind === 'danger' ? '#ff5a6a' : '#f4f1ea' }]}>{label}</Text>
    </Pressable>
  );
}
const Centered = ({ children }: { children: React.ReactNode }) => <View style={[st.screen, { alignItems: 'center', justifyContent: 'center' }]}>{children}</View>;

const st = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1020' },
  top: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)' },
  topTitle: { color: '#f4f1ea', fontSize: 18, fontWeight: '800' },
  testBanner: { backgroundColor: '#f2c14e', color: '#1a1406', textAlign: 'center', fontWeight: '800', paddingVertical: 6, letterSpacing: 1 },
  body: { flexGrow: 1, padding: 20, justifyContent: 'center' },
  web: { flex: 1, backgroundColor: '#0b1020' },
  webBox: { flex: 1 },
  webCover: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0b1020' },
  hidden: { display: 'none' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(11,16,32,0.96)', padding: 20, justifyContent: 'center' },
  pill: { borderRadius: 20, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, maxWidth: 210 },
  pillOk: { borderColor: 'rgba(57,217,138,0.4)', backgroundColor: 'rgba(57,217,138,0.1)' },
  pillBad: { borderColor: 'rgba(255,90,106,0.45)', backgroundColor: 'rgba(255,90,106,0.1)' },
  pillText: { fontSize: 13, fontWeight: '800' },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)', backgroundColor: '#111831' },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12, flexDirection: 'row', justifyContent: 'center', gap: 6 },
  tabText: { color: '#9aa3c0', fontSize: 15, fontWeight: '700' },
  tabOn: { color: '#f2c14e' },
  badge: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ff5a6a' },
  card: { backgroundColor: '#111831', borderRadius: 18, padding: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', alignItems: 'stretch' },
  cardOk: { borderColor: '#39d98a' },
  cardBad: { borderColor: '#ff5a6a' },
  amount: { color: '#f4f1ea', fontSize: 64, fontWeight: '800', textAlign: 'center' },
  buyer: { color: '#9aa3c0', fontSize: 18, textAlign: 'center', marginTop: 4 },
  big: { color: '#f2c14e', fontSize: 28, fontWeight: '800', textAlign: 'center', marginTop: 12 },
  ready: { color: '#39d98a', fontSize: 40, fontWeight: '800', textAlign: 'center' },
  h1: { color: '#f4f1ea', fontSize: 26, fontWeight: '800', marginBottom: 8 },
  h2: { color: '#f4f1ea', fontSize: 22, fontWeight: '800', marginBottom: 8 },
  text: { color: '#f4f1ea', fontSize: 16, textAlign: 'center', marginTop: 6 },
  dim: { color: '#6d7699', fontSize: 13 },
  note: { color: '#f2c14e', fontSize: 14, textAlign: 'center', marginTop: 12 },
  problem: { color: '#ff5a6a', fontSize: 14, textAlign: 'center', marginTop: 16 },
  label: { color: '#9aa3c0', fontSize: 13, fontWeight: '700', marginTop: 16, marginBottom: 6 },
  input: { backgroundColor: '#111831', color: '#f4f1ea', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', padding: 14, fontSize: 17 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  link: { color: '#6fa8ff', fontSize: 16, fontWeight: '600' },
  readerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)' },
  btn: { backgroundColor: '#f2c14e', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 18 },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  btnDanger: { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,90,106,0.5)' },
  btnText: { color: '#1a1406', fontSize: 18, fontWeight: '800' },
});
