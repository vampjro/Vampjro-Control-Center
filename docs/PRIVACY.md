# VAMPJRO Remote Control Center — Privacy Policy

## Principio

I tuoi dati restano sul tuo PC e sulla tua rete locale.

## Cosa NON viene inviato

VAMPJRO Remote Control Center non invia a VAMPJRO o a server esterni:

- CPU, RAM, GPU, processi, hostname, username
- IP, MAC address, device fingerprint
- Screenshot, clipboard, file, percorsi locali
- Crash logs, usage analytics, diagnostica
- Password, PIN, token di sessione
- Informazioni sulle finestre, output PowerShell
- Dati personali di qualsiasi tipo

## Come funziona

Il controllo remoto opera esclusivamente sulla rete locale (LAN) tra il PC e l'iPhone. Non è richiesto un account cloud. Non ci sono server intermedi.

## Connessioni esterne

L'unica connessione verso Internet è il **controllo aggiornamenti**, che:

- Legge un Gist GitHub pubblico per verificare la disponibilità di nuove versioni
- Non invia alcun dato personale (solo un User-Agent generico: "VAMPJRO-UpdateCheck")
- È disattivabile rimuovendo il `gistId` dalla configurazione
- Il ping di rete (`ping 8.8.8.8`) verifica solo la connettività — nessun dato trasmesso

## Archiviazione locale

I dati salvati localmente (nella cartella `local-data/`) includono:

- Hash del PIN (scrypt con salt — il PIN non è mai salvato in chiaro)
- Configurazione utente (tier, intervalli, moduli attivi)
- Log del server (max 512 KB, rotazione automatica, 3 file)

Questi file non vengono mai trasmessi in rete.

## Distribuzione

Il pacchetto distribuito non contiene:

- `.env`, token GitHub, API key, password
- Database, log, screenshot, clipboard
- Hostname, username, IP, percorsi personali
- Configurazioni sviluppatore, artefatti di test

## Garanzia

**Zero telemetria. Zero analytics. Zero tracking. Zero fingerprinting. Zero crash reporting.**
