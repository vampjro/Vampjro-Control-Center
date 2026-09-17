# VAMPJRO Remote Control Center

Controlla il tuo PC Windows dall'iPhone via LAN. Dashboard di sistema, processi, volume, luminosità, screenshot, clipboard, terminale PowerShell, Apple Music, Discord Canary e molto altro.

## Requisiti

- Windows 10/11
- Node.js 18+
- iPhone (o qualsiasi browser) sulla stessa rete Wi-Fi

## Installazione

**Utente finale:** scaricare `VAMPJRO Build.exe` (Control Center) o `VAMPJRO Build Owner.exe` (Owner) da `release/` e avviarlo — nessuna dipendenza da installare, tutto viene gestito automaticamente sotto `%LOCALAPPDATA%\VAMPJRO\`.

**Sviluppo:**
1. Clonare il repository
2. Aprire un terminale nella cartella del progetto
3. `npm install`
4. `node src/server/index.js` oppure doppio click su `tools/start.bat`

Al primo avvio viene richiesto un PIN di accesso (4-6 cifre).

## Utilizzo

1. Avviare il server sul PC
2. Aprire l'indirizzo mostrato nel terminale (es. `http://192.168.1.3:3000`) dall'iPhone
3. Inserire il PIN configurato
4. Aggiungere alla Home Screen per esperienza PWA nativa

## Moduli

| Modulo | Descrizione |
|--------|-------------|
| Dashboard | CPU, RAM, disco, batteria, uptime |
| Processi | Lista processi, ricerca, kill |
| Controlli | Volume, luminosità, blocca/sospendi/riavvia/spegni |
| Screenshot | Cattura schermo remota |
| Clipboard | Sincronizza appunti PC ↔ iPhone |
| Finestre | Lista e gestione finestre aperte |
| Rete | Interfacce, gateway, ping |
| Archiviazione | Partizioni e spazio disco |
| Audio Mixer | Volume per applicazione |
| PowerShell | Terminale amministrativo remoto |
| Keep Awake | Impedisci sospensione PC |
| Discord | Stato Discord Canary + Vencord + Orion |
| Apple Music | Telecomando Apple Music via estensione browser |
| Aggiornamenti | Controllo aggiornamenti via GitHub Gist |

## Sicurezza

- PIN con hash scrypt e salt casuale
- Rate limiting (5 tentativi → cooldown 60s)
- Token di sessione con scadenza (24h)
- Permessi a livelli (READ/CONTROL/DANGEROUS/ADMIN)
- Safe Mode per bloccare azioni pericolose
- Nessun dato esce dalla rete locale

## Privacy

Zero telemetria. Zero analytics. Zero tracking.

Tutti i dati restano sul PC e sulla rete locale. L'unica connessione esterna è il controllo aggiornamenti (lettura di un Gist GitHub pubblico, senza invio di dati personali).

Vedi [PRIVACY.md](PRIVACY.md) per la policy completa.

## Avvio automatico

Per avviare VAMPJRO automaticamente al login:

```
tools\install-autostart.bat
```

Per rimuoverlo:

```
tools\remove-autostart.bat
```

Richiedono privilegi di amministratore.

## Aggiornamenti

L'EXE distribuito include già l'ID del Gist di aggiornamento: nessuna configurazione manuale richiesta. Il server controlla periodicamente la disponibilità di nuove versioni, permette di scaricarle e verificarne l'integrità (SHA-256) prima di installarle — mai in automatico, sempre con conferma esplicita dell'utente.

In sviluppo, `updates.gistId` è `null` di default in `local-data/config.json`; per testare il controllo aggiornamenti localmente, impostalo manualmente all'ID di un Gist pubblico con il manifesto `vampjro-updates.json`.

Il token GitHub è necessario solo lato sviluppatore per pubblicare aggiornamenti (vedi `.env.release` e l'app Owner) — non è mai incluso nell'applicazione distribuita.

## Reimpostare il PIN

Se il PIN di accesso viene dimenticato:

1. Chiudi VAMPJRO (chiudi la finestra del terminale o il processo in background)
2. Elimina il file `config.json` dalla cartella dati:
   - Utente finale: `%LOCALAPPDATA%\VAMPJRO\Data\ControlCenter\config.json`
   - Sviluppo: `local-data/config.json`
3. Riavvia VAMPJRO: al primo accesso verrà richiesto di creare un nuovo PIN

Questo riporta l'intera configurazione ai valori di default (PIN incluso) — in pratica, per un'installazione normale, l'unica differenza percepibile è dover creare un nuovo PIN. Non tocca screenshot, log o altri dati salvati altrove nella cartella `Data`.

## Struttura

```
├── src/
│   ├── client/       # PWA Control Center (HTML/JS/CSS)
│   ├── server/       # Server Control Center
│   │   ├── core/     # Config, logger, module-manager, watchdog
│   │   ├── modules/  # Moduli funzionali
│   │   ├── security/ # Auth, permessi
│   │   ├── utils/    # Hardware profile, PowerShell helper
│   │   └── websocket/# Protocol, handler
│   ├── owner/        # App Owner (proprio client/ e server/)
│   ├── backend/      # Backend control-plane (sql.js, WebSocket)
│   ├── shared/        # Protocollo condiviso tra i tre progetti
│   ├── config/       # Configurazione di default (Control Center)
│   └── extension/    # Estensione browser Apple Music
├── build/
│   ├── scripts/      # build-installer.js (build attivo), build-dist.js (legacy)
│   ├── installers/   # control-center.iss, control-owner.iss (Inno Setup)
│   └── resources/    # Icone, node-runtime imbustato
├── tools/            # Launcher di sviluppo, autostart, regression test
├── tests/            # Suite di test automatici
├── docs/             # Changelog, privacy, report di sessione
├── release/          # VAMPJRO Build.exe, VAMPJRO Build Owner.exe
├── archive/          # Snapshot storici (mai eliminati, non toccati da build/install)
├── package.json
└── README.md
```

## Supporto

[t.me/vampjro](https://t.me/vampjro)
