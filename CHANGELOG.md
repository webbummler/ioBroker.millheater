# Changelog

## 0.0.4

- API-Zugriffe gegen parallele Anfragen abgesichert
- Beim Beenden des Adapters werden wartende und laufende API-Anfragen berücksichtigt
- info.connection ergänzt
- Unterstützung für Node.js 22 aktualisiert
- Abhängigkeiten und TypeScript-Konfiguration auf Node.js 22 aktualisiert

## 0.0.3

- Konfigurierbaren API-Timeout hinzugefügt
- Validierung der schnellen und langsamen Abfrageintervalle anhand des konfigurierten API-Timeouts hinzugefügt

## 0.0.2

- Objektstruktur überarbeitet
- Kein zusätzliches Device-Objekt für einzelne Heater
- Adapterinstanz ist jeweils einem Heater zugeordnet
- info.connection ergänzt

## 0.0.1

- Erste Version
- Lokale Mill-Heater-API integriert
- Auslesen von Status, Control-Status und Einstellungen