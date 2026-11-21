"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var deviceStates_exports = {};
__export(deviceStates_exports, {
  DEVICE_CHANNELS: () => DEVICE_CHANNELS,
  DEVICE_STATES: () => DEVICE_STATES
});
module.exports = __toCommonJS(deviceStates_exports);
const DEVICE_CHANNELS = [
  ["control-status", "Control status"],
  ["info", "Information"],
  ["status", "Status"],
  ["settings", "Settings"]
];
const DEVICE_STATES = [
  // Device information added for multi-device support.
  {
    id: "info.connection",
    common: {
      name: {
        en: "Device online",
        de: "Ger\xE4t online",
        ru: "\u0423\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E \u043E\u043D\u043B\u0430\u0439\u043D",
        pt: "Dispositivo online",
        nl: "Apparaat online",
        fr: "Appareil en ligne",
        it: "Dispositivo online",
        es: "Dispositivo en l\xEDnea",
        pl: "Urz\u0105dzenie online",
        uk: "\u041F\u0440\u0438\u0441\u0442\u0440\u043E\u0457 \u043E\u043D\u043B\u0430\u0439\u043D",
        "zh-cn": "\u8BBE\u5907\u5728\u7EBF"
      },
      type: "boolean",
      role: "indicator.reachable",
      read: true,
      write: false
    }
  },
  {
    id: "info.name",
    common: {
      name: {
        en: "Configured device name",
        de: "Konfigurierter Ger\xE4tename",
        ru: "\u041D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u043D\u043E\u0435 \u0438\u043C\u044F \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430",
        pt: "Nome configurado do dispositivo",
        nl: "Ingestelde apparaatnaam",
        fr: "Nom configur\xE9 de l\u2019appareil",
        it: "Nome configurato del dispositivo",
        es: "Nombre configurado del dispositivo",
        pl: "Skonfigurowana nazwa urz\u0105dzenia",
        uk: "\u041D\u0430\u043B\u0430\u0448\u0442\u043E\u0432\u0430\u043D\u0430 \u043D\u0430\u0437\u0432\u0430 \u043F\u0440\u0438\u0441\u0442\u0440\u043E\u044E",
        "zh-cn": "\u5DF2\u914D\u7F6E\u7684\u8BBE\u5907\u540D\u79F0"
      },
      type: "string",
      role: "info.name",
      read: true,
      write: false
    }
  },
  {
    id: "info.host",
    common: {
      name: {
        en: "Configured IP address or hostname",
        de: "Konfigurierte IP-Adresse oder Hostname",
        ru: "\u041D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u043D\u044B\u0439 IP-\u0430\u0434\u0440\u0435\u0441 \u0438\u043B\u0438 \u0438\u043C\u044F \u0445\u043E\u0441\u0442\u0430",
        pt: "Endere\xE7o IP ou nome do host configurado",
        nl: "Geconfigureerd IP-adres of hostnaam",
        fr: "Adresse IP ou nom d\u2019h\xF4te configur\xE9",
        it: "Indirizzo IP o nome host configurato",
        es: "Direcci\xF3n IP o nombre de host configurado",
        pl: "Skonfigurowany adres IP lub nazwa hosta",
        uk: "\u041D\u0430\u043B\u0430\u0448\u0442\u043E\u0432\u0430\u043D\u0430 IP-\u0430\u0434\u0440\u0435\u0441\u0430 \u0430\u0431\u043E \u0456\u043C\u2019\u044F \u0445\u043E\u0441\u0442\u0430",
        "zh-cn": "\u5DF2\u914D\u7F6E\u7684 IP \u5730\u5740\u6216\u4E3B\u673A\u540D"
      },
      type: "string",
      role: "info.ip",
      read: true,
      write: false
    }
  },
  {
    id: "info.deviceType",
    common: {
      name: {
        en: "Device type",
        de: "Ger\xE4tetyp",
        ru: "\u0422\u0438\u043F \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430",
        pt: "Tipo de dispositivo",
        nl: "Apparaattype",
        fr: "Type d\u2019appareil",
        it: "Tipo di dispositivo",
        es: "Tipo de dispositivo",
        pl: "Typ urz\u0105dzenia",
        uk: "\u0422\u0438\u043F \u043F\u0440\u0438\u0441\u0442\u0440\u043E\u044E",
        "zh-cn": "\u8BBE\u5907\u7C7B\u578B"
      },
      type: "string",
      role: "text",
      read: true,
      write: false
    }
  },
  // CONTROL STATUS
  {
    id: "control-status.ambient_temperature",
    common: {
      name: {
        en: "Temperature measured by the sensor in degrees Celsius, including the calibration offset",
        de: "Vom Sensor gemessene Temperatur in Grad Celsius einschlie\xDFlich Kalibrierkorrektur",
        ru: "\u0422\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430, \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u0430\u044F \u0434\u0430\u0442\u0447\u0438\u043A\u043E\u043C \u0432 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0438\u044F, \u0441 \u0443\u0447\u0435\u0442\u043E\u043C \u043A\u0430\u043B\u0438\u0431\u0440\u043E\u0432\u043E\u0447\u043D\u043E\u0439 \u043F\u043E\u043F\u0440\u0430\u0432\u043A\u0438",
        pt: "Temperatura medida pelo sensor em graus Celsius, incluindo a corre\xE7\xE3o de calibra\xE7\xE3o",
        nl: "Door de sensor gemeten temperatuur in graden Celsius, inclusief kalibratiecorrectie",
        fr: "Temp\xE9rature mesur\xE9e par le capteur en degr\xE9s Celsius, correction d\u2019\xE9talonnage incluse",
        it: "Temperatura misurata dal sensore in gradi Celsius, inclusa la correzione di calibrazione",
        es: "Temperatura medida por el sensor en grados Celsius, incluida la correcci\xF3n de calibraci\xF3n",
        pl: "Temperatura zmierzona przez czujnik w stopniach Celsjusza, z uwzgl\u0119dnieniem korekty kalibracji",
        uk: "\u0422\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430, \u0432\u0438\u043C\u0456\u0440\u044F\u043D\u0430 \u0434\u0430\u0442\u0447\u0438\u043A\u043E\u043C \u0443 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0456\u044F, \u0437 \u0443\u0440\u0430\u0445\u0443\u0432\u0430\u043D\u043D\u044F\u043C \u043A\u0430\u043B\u0456\u0431\u0440\u0443\u0432\u0430\u043B\u044C\u043D\u043E\u0457 \u043F\u043E\u043F\u0440\u0430\u0432\u043A\u0438",
        "zh-cn": "\u4F20\u611F\u5668\u6D4B\u5F97\u7684\u6444\u6C0F\u6E29\u5EA6\uFF0C\u5305\u542B\u6821\u51C6\u504F\u79FB\u91CF"
      },
      type: "number",
      role: "value.temperature",
      read: true,
      write: false,
      unit: "\xB0C"
    }
  },
  {
    id: "control-status.connected_to_cloud",
    common: {
      name: {
        en: "Indicates whether the device is connected to the cloud",
        de: "Gibt an, ob das Ger\xE4t mit der Cloud verbunden ist",
        ru: "\u0423\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442, \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043E \u043B\u0438 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E \u043A \u043E\u0431\u043B\u0430\u043A\u0443",
        pt: "Indica se o dispositivo est\xE1 conectado \xE0 nuvem",
        nl: "Geeft aan of het apparaat met de cloud is verbonden",
        fr: "Indique si l\u2019appareil est connect\xE9 au cloud",
        it: "Indica se il dispositivo \xE8 connesso al cloud",
        es: "Indica si el dispositivo est\xE1 conectado a la nube",
        pl: "Informuje, czy urz\u0105dzenie jest po\u0142\u0105czone z chmur\u0105",
        uk: "\u0412\u043A\u0430\u0437\u0443\u0454, \u0447\u0438 \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043E \u043F\u0440\u0438\u0441\u0442\u0440\u0456\u0439 \u0434\u043E \u0445\u043C\u0430\u0440\u0438",
        "zh-cn": "\u6307\u793A\u8BBE\u5907\u662F\u5426\u5DF2\u8FDE\u63A5\u5230\u4E91\u7AEF"
      },
      type: "boolean",
      role: "sensor",
      read: true,
      write: false
    }
  },
  {
    id: "control-status.control_signal",
    common: {
      name: {
        en: "Control signal of the PID controller (0\u2013100%)",
        de: "Stellsignal des PID-Reglers (0\u2013100 %)",
        ru: "\u0423\u043F\u0440\u0430\u0432\u043B\u044F\u044E\u0449\u0438\u0439 \u0441\u0438\u0433\u043D\u0430\u043B \u041F\u0418\u0414-\u0440\u0435\u0433\u0443\u043B\u044F\u0442\u043E\u0440\u0430 (0\u2013100 %)",
        pt: "Sinal de controlo do regulador PID (0\u2013100%)",
        nl: "Stuursignaal van de PID-regelaar (0\u2013100%)",
        fr: "Signal de commande du r\xE9gulateur PID (0\u2013100 %)",
        it: "Segnale di controllo del regolatore PID (0\u2013100%)",
        es: "Se\xF1al de control del regulador PID (0\u2013100 %)",
        pl: "Sygna\u0142 steruj\u0105cy regulatora PID (0\u2013100%)",
        uk: "\u041A\u0435\u0440\u0443\u044E\u0447\u0438\u0439 \u0441\u0438\u0433\u043D\u0430\u043B \u041F\u0406\u0414-\u0440\u0435\u0433\u0443\u043B\u044F\u0442\u043E\u0440\u0430 (0\u2013100 %)",
        "zh-cn": "PID \u63A7\u5236\u5668\u7684\u63A7\u5236\u4FE1\u53F7\uFF080\u2013100%\uFF09"
      },
      type: "number",
      role: "value",
      read: true,
      write: false,
      unit: "%",
      min: 0,
      max: 100
    }
  },
  {
    id: "control-status.current_power",
    common: {
      name: {
        en: "Current heating power in watts",
        de: "Aktuelle Heizleistung in Watt",
        ru: "\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u043C\u043E\u0449\u043D\u043E\u0441\u0442\u044C \u043D\u0430\u0433\u0440\u0435\u0432\u0430 \u0432 \u0432\u0430\u0442\u0442\u0430\u0445",
        pt: "Pot\xEAncia de aquecimento atual em watts",
        nl: "Huidig verwarmingsvermogen in watt",
        fr: "Puissance de chauffage actuelle en watts",
        it: "Potenza di riscaldamento attuale in watt",
        es: "Potencia de calefacci\xF3n actual en vatios",
        pl: "Aktualna moc grzewcza w watach",
        uk: "\u041F\u043E\u0442\u043E\u0447\u043D\u0430 \u043F\u043E\u0442\u0443\u0436\u043D\u0456\u0441\u0442\u044C \u043D\u0430\u0433\u0440\u0456\u0432\u0430\u043D\u043D\u044F \u0443 \u0432\u0430\u0442\u0430\u0445",
        "zh-cn": "\u5F53\u524D\u52A0\u70ED\u529F\u7387\uFF08\u74E6\uFF09"
      },
      type: "number",
      role: "value.power",
      read: true,
      write: false,
      unit: "W"
    }
  },
  {
    id: "control-status.lock_active",
    common: {
      name: {
        en: "Lock status (No lock, Child lock, Commercial lock)",
        de: "Sperrstatus (No lock, Child lock, Commercial lock)",
        ru: "\u0421\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u043A\u0438 (No lock, Child lock, Commercial lock)",
        pt: "Estado do bloqueio (No lock, Child lock, Commercial lock)",
        nl: "Vergrendelingsstatus (No lock, Child lock, Commercial lock)",
        fr: "\xC9tat du verrouillage (No lock, Child lock, Commercial lock)",
        it: "Stato del blocco (No lock, Child lock, Commercial lock)",
        es: "Estado del bloqueo (No lock, Child lock, Commercial lock)",
        pl: "Stan blokady (No lock, Child lock, Commercial lock)",
        uk: "\u0421\u0442\u0430\u043D \u0431\u043B\u043E\u043A\u0443\u0432\u0430\u043D\u043D\u044F (No lock, Child lock, Commercial lock)",
        "zh-cn": "\u9501\u5B9A\u72B6\u6001\uFF08No lock, Child lock, Commercial lock\uFF09"
      },
      type: "string",
      role: "state",
      read: true,
      write: false
    }
  },
  {
    id: "control-status.open_window_active_now",
    common: {
      name: {
        en: "Open-window status (Disabled not active now, Enabled active now, Enabled not active now)",
        de: "Status der Fenstererkennung (Disabled not active now, Enabled active now, Enabled not active now)",
        ru: "\u0421\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u043E\u0431\u043D\u0430\u0440\u0443\u0436\u0435\u043D\u0438\u044F \u043E\u0442\u043A\u0440\u044B\u0442\u043E\u0433\u043E \u043E\u043A\u043D\u0430 (Disabled not active now, Enabled active now, Enabled not active now)",
        pt: "Estado da dete\xE7\xE3o de janela aberta (Disabled not active now, Enabled active now, Enabled not active now)",
        nl: "Status van openraamdetectie (Disabled not active now, Enabled active now, Enabled not active now)",
        fr: "\xC9tat de la d\xE9tection de fen\xEAtre ouverte (Disabled not active now, Enabled active now, Enabled not active now)",
        it: "Stato del rilevamento della finestra aperta (Disabled not active now, Enabled active now, Enabled not active now)",
        es: "Estado de la detecci\xF3n de ventana abierta (Disabled not active now, Enabled active now, Enabled not active now)",
        pl: "Stan wykrywania otwartego okna (Disabled not active now, Enabled active now, Enabled not active now)",
        uk: "\u0421\u0442\u0430\u043D \u0432\u0438\u044F\u0432\u043B\u0435\u043D\u043D\u044F \u0432\u0456\u0434\u043A\u0440\u0438\u0442\u043E\u0433\u043E \u0432\u0456\u043A\u043D\u0430 (Disabled not active now, Enabled active now, Enabled not active now)",
        "zh-cn": "\u5F00\u7A97\u68C0\u6D4B\u72B6\u6001\uFF08Disabled not active now, Enabled active now, Enabled not active now\uFF09"
      },
      type: "string",
      role: "state",
      read: true,
      write: false
    }
  },
  {
    id: "control-status.operation_mode",
    common: {
      name: {
        en: "Current mode of operation",
        de: "Aktueller Betriebsmodus",
        ru: "\u0422\u0435\u043A\u0443\u0449\u0438\u0439 \u0440\u0435\u0436\u0438\u043C \u0440\u0430\u0431\u043E\u0442\u044B",
        pt: "Modo de funcionamento atual",
        nl: "Huidige bedrijfsmodus",
        fr: "Mode de fonctionnement actuel",
        it: "Modalit\xE0 operativa corrente",
        es: "Modo de funcionamiento actual",
        pl: "Aktualny tryb pracy",
        uk: "\u041F\u043E\u0442\u043E\u0447\u043D\u0438\u0439 \u0440\u0435\u0436\u0438\u043C \u0440\u043E\u0431\u043E\u0442\u0438",
        "zh-cn": "\u5F53\u524D\u8FD0\u884C\u6A21\u5F0F"
      },
      type: "string",
      role: "state",
      read: true,
      write: true,
      states: {
        Off: "Off",
        "Weekly program": "Weekly program",
        "Independent device": "Independent device",
        "Control individually": "Control individually"
      }
    }
  },
  {
    id: "control-status.raw_ambient_temperature",
    common: {
      name: {
        en: "Temperature measured by the sensor in degrees Celsius, without the calibration offset",
        de: "Vom Sensor gemessene Temperatur in Grad Celsius ohne Kalibrierkorrektur",
        ru: "\u0422\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430, \u0438\u0437\u043C\u0435\u0440\u0435\u043D\u043D\u0430\u044F \u0434\u0430\u0442\u0447\u0438\u043A\u043E\u043C \u0432 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0438\u044F, \u0431\u0435\u0437 \u043A\u0430\u043B\u0438\u0431\u0440\u043E\u0432\u043E\u0447\u043D\u043E\u0439 \u043F\u043E\u043F\u0440\u0430\u0432\u043A\u0438",
        pt: "Temperatura medida pelo sensor em graus Celsius, sem a corre\xE7\xE3o de calibra\xE7\xE3o",
        nl: "Door de sensor gemeten temperatuur in graden Celsius, zonder kalibratiecorrectie",
        fr: "Temp\xE9rature mesur\xE9e par le capteur en degr\xE9s Celsius, sans correction d\u2019\xE9talonnage",
        it: "Temperatura misurata dal sensore in gradi Celsius, senza correzione di calibrazione",
        es: "Temperatura medida por el sensor en grados Celsius, sin la correcci\xF3n de calibraci\xF3n",
        pl: "Temperatura zmierzona przez czujnik w stopniach Celsjusza, bez korekty kalibracji",
        uk: "\u0422\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430, \u0432\u0438\u043C\u0456\u0440\u044F\u043D\u0430 \u0434\u0430\u0442\u0447\u0438\u043A\u043E\u043C \u0443 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0456\u044F, \u0431\u0435\u0437 \u043A\u0430\u043B\u0456\u0431\u0440\u0443\u0432\u0430\u043B\u044C\u043D\u043E\u0457 \u043F\u043E\u043F\u0440\u0430\u0432\u043A\u0438",
        "zh-cn": "\u4F20\u611F\u5668\u6D4B\u5F97\u7684\u6444\u6C0F\u6E29\u5EA6\uFF0C\u4E0D\u5305\u542B\u6821\u51C6\u504F\u79FB\u91CF"
      },
      type: "number",
      role: "value.temperature",
      read: true,
      write: false,
      unit: "\xB0C"
    }
  },
  {
    id: "control-status.set_temperature",
    common: {
      name: {
        en: "Current set temperature in degrees Celsius",
        de: "Aktuelle Solltemperatur in Grad Celsius",
        ru: "\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u0437\u0430\u0434\u0430\u043D\u043D\u0430\u044F \u0442\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430 \u0432 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0438\u044F",
        pt: "Temperatura definida atual em graus Celsius",
        nl: "Huidige ingestelde temperatuur in graden Celsius",
        fr: "Temp\xE9rature de consigne actuelle en degr\xE9s Celsius",
        it: "Temperatura impostata attuale in gradi Celsius",
        es: "Temperatura de consigna actual en grados Celsius",
        pl: "Aktualna temperatura zadana w stopniach Celsjusza",
        uk: "\u041F\u043E\u0442\u043E\u0447\u043D\u0430 \u0437\u0430\u0434\u0430\u043D\u0430 \u0442\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0430 \u0432 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0456\u044F",
        "zh-cn": "\u5F53\u524D\u8BBE\u5B9A\u6E29\u5EA6\uFF08\u6444\u6C0F\u5EA6\uFF09"
      },
      type: "number",
      role: "level.temperature",
      read: true,
      write: true,
      min: 5,
      max: 35,
      unit: "\xB0C"
    }
  },
  {
    id: "control-status.switched_on",
    common: {
      name: {
        en: "Indicates whether the device is switched on and set to operate with heating",
        de: "Gibt an, ob das Ger\xE4t eingeschaltet und zum Heizen aktiviert ist",
        ru: "\u0423\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442, \u0432\u043A\u043B\u044E\u0447\u0435\u043D\u043E \u043B\u0438 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E \u0438 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u043E \u043B\u0438 \u043E\u043D\u043E \u043D\u0430 \u0440\u0430\u0431\u043E\u0442\u0443 \u0441 \u043E\u0431\u043E\u0433\u0440\u0435\u0432\u043E\u043C",
        pt: "Indica se o dispositivo est\xE1 ligado e configurado para funcionar com aquecimento",
        nl: "Geeft aan of het apparaat is ingeschakeld en is ingesteld om te verwarmen",
        fr: "Indique si l\u2019appareil est allum\xE9 et r\xE9gl\xE9 pour fonctionner en mode chauffage",
        it: "Indica se il dispositivo \xE8 acceso e impostato per funzionare con il riscaldamento",
        es: "Indica si el dispositivo est\xE1 encendido y configurado para funcionar con calefacci\xF3n",
        pl: "Informuje, czy urz\u0105dzenie jest w\u0142\u0105czone i ustawione do pracy z ogrzewaniem",
        uk: "\u0412\u043A\u0430\u0437\u0443\u0454, \u0447\u0438 \u0443\u0432\u0456\u043C\u043A\u043D\u0435\u043D\u043E \u043F\u0440\u0438\u0441\u0442\u0440\u0456\u0439 \u0456 \u043D\u0430\u043B\u0430\u0448\u0442\u043E\u0432\u0430\u043D\u043E \u0439\u043E\u0433\u043E \u043D\u0430 \u0440\u043E\u0431\u043E\u0442\u0443 \u0437 \u043E\u0431\u0456\u0433\u0440\u0456\u0432\u043E\u043C",
        "zh-cn": "\u6307\u793A\u8BBE\u5907\u662F\u5426\u5DF2\u5F00\u542F\u5E76\u8BBE\u7F6E\u4E3A\u52A0\u70ED\u8FD0\u884C"
      },
      type: "boolean",
      role: "sensor.switch",
      read: true,
      write: false
    }
  },
  // SETTINGS
  {
    id: "settings.additional_mode",
    common: {
      name: {
        en: "Additional socket mode",
        de: "Zus\xE4tzlicher Steckdosenmodus",
        ru: "\u0414\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C \u0440\u043E\u0437\u0435\u0442\u043A\u0438",
        pt: "Modo adicional da tomada",
        nl: "Extra stopcontactmodus",
        fr: "Mode suppl\xE9mentaire de la prise",
        it: "Modalit\xE0 aggiuntiva della presa",
        es: "Modo adicional del enchufe",
        pl: "Dodatkowy tryb gniazda",
        uk: "\u0414\u043E\u0434\u0430\u0442\u043A\u043E\u0432\u0438\u0439 \u0440\u0435\u0436\u0438\u043C \u0440\u043E\u0437\u0435\u0442\u043A\u0438",
        "zh-cn": "\u9644\u52A0\u63D2\u5EA7\u6A21\u5F0F"
      },
      type: "number",
      role: "state",
      read: true,
      write: true,
      min: 0,
      max: 4,
      step: 1
    }
  },
  {
    id: "settings.heating_level_percentage",
    common: {
      name: {
        en: "Heating level in percent",
        de: "Heizstufe in Prozent",
        ru: "\u0423\u0440\u043E\u0432\u0435\u043D\u044C \u043D\u0430\u0433\u0440\u0435\u0432\u0430 \u0432 \u043F\u0440\u043E\u0446\u0435\u043D\u0442\u0430\u0445",
        pt: "N\xEDvel de aquecimento em percentagem",
        nl: "Verwarmingsniveau in procenten",
        fr: "Niveau de chauffage en pourcentage",
        it: "Livello di riscaldamento in percentuale",
        es: "Nivel de calefacci\xF3n en porcentaje",
        pl: "Poziom ogrzewania w procentach",
        uk: "\u0420\u0456\u0432\u0435\u043D\u044C \u043D\u0430\u0433\u0440\u0456\u0432\u0430\u043D\u043D\u044F \u0443 \u0432\u0456\u0434\u0441\u043E\u0442\u043A\u0430\u0445",
        "zh-cn": "\u52A0\u70ED\u7B49\u7EA7\uFF08\u767E\u5206\u6BD4\uFF09"
      },
      type: "number",
      role: "level",
      read: true,
      write: true,
      states: { 40: "40", 60: "60", 100: "100" },
      unit: "%"
    }
  },
  {
    id: "settings.limited_heating_power",
    common: {
      name: {
        en: "Percentage of maximum power the heater can use (10\u2013100)",
        de: "Prozentsatz der maximalen Leistung, die der Heizk\xF6rper nutzen darf (10\u2013100)",
        ru: "\u041F\u0440\u043E\u0446\u0435\u043D\u0442 \u043C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u043E\u0439 \u043C\u043E\u0449\u043D\u043E\u0441\u0442\u0438, \u043A\u043E\u0442\u043E\u0440\u0443\u044E \u043C\u043E\u0436\u0435\u0442 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u044C \u043E\u0431\u043E\u0433\u0440\u0435\u0432\u0430\u0442\u0435\u043B\u044C (10\u2013100)",
        pt: "Percentagem da pot\xEAncia m\xE1xima que o aquecedor pode utilizar (10\u2013100)",
        nl: "Percentage van het maximale vermogen dat de verwarming mag gebruiken (10\u2013100)",
        fr: "Pourcentage de la puissance maximale que le radiateur peut utiliser (10\u2013100)",
        it: "Percentuale della potenza massima che il riscaldatore pu\xF2 utilizzare (10\u2013100)",
        es: "Porcentaje de la potencia m\xE1xima que puede utilizar el calefactor (10\u2013100)",
        pl: "Procent maksymalnej mocy, kt\xF3r\u0105 mo\u017Ce wykorzystywa\u0107 grzejnik (10\u2013100)",
        uk: "\u0412\u0456\u0434\u0441\u043E\u0442\u043E\u043A \u043C\u0430\u043A\u0441\u0438\u043C\u0430\u043B\u044C\u043D\u043E\u0457 \u043F\u043E\u0442\u0443\u0436\u043D\u043E\u0441\u0442\u0456, \u044F\u043A\u0443 \u043C\u043E\u0436\u0435 \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u043E\u0432\u0443\u0432\u0430\u0442\u0438 \u043E\u0431\u0456\u0433\u0440\u0456\u0432\u0430\u0447 (10\u2013100)",
        "zh-cn": "\u52A0\u70ED\u5668\u53EF\u4F7F\u7528\u7684\u6700\u5927\u529F\u7387\u767E\u5206\u6BD4\uFF0810\u2013100\uFF09"
      },
      type: "number",
      role: "level",
      read: true,
      write: true,
      unit: "%",
      min: 10,
      max: 100
    }
  },
  {
    id: "settings.temperature_calibration_offset",
    common: {
      name: {
        en: "Temperature calibration offset in degrees Celsius",
        de: "Temperatur-Kalibrierkorrektur in Grad Celsius",
        ru: "\u041F\u043E\u043F\u0440\u0430\u0432\u043A\u0430 \u043A\u0430\u043B\u0438\u0431\u0440\u043E\u0432\u043A\u0438 \u0442\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u044B \u0432 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0438\u044F",
        pt: "Corre\xE7\xE3o de calibra\xE7\xE3o da temperatura em graus Celsius",
        nl: "Temperatuurkalibratiecorrectie in graden Celsius",
        fr: "Correction d\u2019\xE9talonnage de la temp\xE9rature en degr\xE9s Celsius",
        it: "Correzione di calibrazione della temperatura in gradi Celsius",
        es: "Correcci\xF3n de calibraci\xF3n de la temperatura en grados Celsius",
        pl: "Korekta kalibracji temperatury w stopniach Celsjusza",
        uk: "\u041F\u043E\u043F\u0440\u0430\u0432\u043A\u0430 \u043A\u0430\u043B\u0456\u0431\u0440\u0443\u0432\u0430\u043D\u043D\u044F \u0442\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0438 \u0432 \u0433\u0440\u0430\u0434\u0443\u0441\u0430\u0445 \u0426\u0435\u043B\u044C\u0441\u0456\u044F",
        "zh-cn": "\u6E29\u5EA6\u6821\u51C6\u504F\u79FB\u91CF\uFF08\u6444\u6C0F\u5EA6\uFF09"
      },
      type: "number",
      role: "level",
      read: true,
      write: true,
      min: -30,
      max: 30,
      unit: "\xB0C"
    }
  },
  // STATUS
  {
    id: "status.custom_name",
    common: {
      name: {
        en: "Custom name reported by Mill API",
        de: "Benutzerdefinierter Name laut Mill-API",
        ru: "\u041F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044C\u0441\u043A\u043E\u0435 \u0438\u043C\u044F \u0438\u0437 API Mill",
        pt: "Nome personalizado informado pela API Mill",
        nl: "Aangepaste naam volgens de Mill-API",
        fr: "Nom personnalis\xE9 fourni par l\u2019API Mill",
        it: "Nome personalizzato restituito dall\u2019API Mill",
        es: "Nombre personalizado devuelto por la API de Mill",
        pl: "Nazwa w\u0142asna zwr\xF3cona przez API Mill",
        uk: "\u0412\u043B\u0430\u0441\u043D\u0430 \u043D\u0430\u0437\u0432\u0430 \u0437 API Mill",
        "zh-cn": "Mill API \u8FD4\u56DE\u7684\u81EA\u5B9A\u4E49\u540D\u79F0"
      },
      type: "string",
      role: "info.name",
      read: true,
      write: false
    }
  },
  {
    id: "status.mac_address",
    common: {
      name: {
        en: "Device MAC (Media Access Control) address",
        de: "MAC-Adresse (Media Access Control) des Ger\xE4ts",
        ru: "MAC-\u0430\u0434\u0440\u0435\u0441 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430 (Media Access Control)",
        pt: "Endere\xE7o MAC (Media Access Control) do dispositivo",
        nl: "MAC-adres (Media Access Control) van het apparaat",
        fr: "Adresse MAC (Media Access Control) de l\u2019appareil",
        it: "Indirizzo MAC (Media Access Control) del dispositivo",
        es: "Direcci\xF3n MAC (Media Access Control) del dispositivo",
        pl: "Adres MAC (Media Access Control) urz\u0105dzenia",
        uk: "MAC-\u0430\u0434\u0440\u0435\u0441\u0430 \u043F\u0440\u0438\u0441\u0442\u0440\u043E\u044E (Media Access Control)",
        "zh-cn": "\u8BBE\u5907\u7684 MAC \u5730\u5740\uFF08\u5A92\u4F53\u8BBF\u95EE\u63A7\u5236\uFF09"
      },
      type: "string",
      role: "info.mac",
      read: true,
      write: false
    }
  },
  {
    id: "status.name",
    common: {
      name: {
        en: "Device model reported by Mill API",
        de: "Ger\xE4temodell laut Mill-API",
        ru: "\u041C\u043E\u0434\u0435\u043B\u044C \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430 \u0438\u0437 API Mill",
        pt: "Modelo do dispositivo informado pela API Mill",
        nl: "Apparaatmodel volgens de Mill-API",
        fr: "Mod\xE8le de l\u2019appareil fourni par l\u2019API Mill",
        it: "Modello del dispositivo restituito dall\u2019API Mill",
        es: "Modelo del dispositivo devuelto por la API de Mill",
        pl: "Model urz\u0105dzenia zwr\xF3cony przez API Mill",
        uk: "\u041C\u043E\u0434\u0435\u043B\u044C \u043F\u0440\u0438\u0441\u0442\u0440\u043E\u044E \u0437 API Mill",
        "zh-cn": "Mill API \u8FD4\u56DE\u7684\u8BBE\u5907\u578B\u53F7"
      },
      type: "string",
      role: "info.model",
      read: true,
      write: false
    }
  },
  {
    id: "status.operation_key",
    common: {
      name: {
        en: "If an operational problem occurs (e.g. a faulty temperature sensor), it may be reported in this field.",
        de: "Wenn ein Betriebsproblem auftritt (z. B. ein defekter Temperatursensor), kann es in diesem Feld gemeldet werden.",
        ru: "\u041F\u0440\u0438 \u0432\u043E\u0437\u043D\u0438\u043A\u043D\u043E\u0432\u0435\u043D\u0438\u0438 \u043F\u0440\u043E\u0431\u043B\u0435\u043C\u044B \u0432 \u0440\u0430\u0431\u043E\u0442\u0435 (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, \u043D\u0435\u0438\u0441\u043F\u0440\u0430\u0432\u043D\u043E\u0441\u0442\u0438 \u0434\u0430\u0442\u0447\u0438\u043A\u0430 \u0442\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u044B) \u043E\u043D\u0430 \u043C\u043E\u0436\u0435\u0442 \u043E\u0442\u043E\u0431\u0440\u0430\u0436\u0430\u0442\u044C\u0441\u044F \u0432 \u044D\u0442\u043E\u043C \u043F\u043E\u043B\u0435.",
        pt: "Se ocorrer um problema de funcionamento (por exemplo, um sensor de temperatura avariado), ele poder\xE1 ser indicado neste campo.",
        nl: "Als er een probleem met de werking optreedt (bijvoorbeeld een defecte temperatuursensor), kan dit in dit veld worden gemeld.",
        fr: "En cas de probl\xE8me de fonctionnement (par exemple, un capteur de temp\xE9rature d\xE9fectueux), celui-ci peut \xEAtre signal\xE9 dans ce champ.",
        it: "Se si verifica un problema di funzionamento (ad esempio, un sensore di temperatura guasto), pu\xF2 essere segnalato in questo campo.",
        es: "Si se produce un problema de funcionamiento (por ejemplo, un sensor de temperatura averiado), puede indicarse en este campo.",
        pl: "Je\u015Bli wyst\u0105pi problem z dzia\u0142aniem (np. uszkodzony czujnik temperatury), mo\u017Ce on zosta\u0107 zg\u0142oszony w tym polu.",
        uk: "\u042F\u043A\u0449\u043E \u0432\u0438\u043D\u0438\u043A\u0430\u0454 \u043F\u0440\u043E\u0431\u043B\u0435\u043C\u0430 \u0432 \u0440\u043E\u0431\u043E\u0442\u0456 (\u043D\u0430\u043F\u0440\u0438\u043A\u043B\u0430\u0434, \u043D\u0435\u0441\u043F\u0440\u0430\u0432\u043D\u0438\u0439 \u0434\u0430\u0442\u0447\u0438\u043A \u0442\u0435\u043C\u043F\u0435\u0440\u0430\u0442\u0443\u0440\u0438), \u0457\u0457 \u043C\u043E\u0436\u043D\u0430 \u0432\u043A\u0430\u0437\u0430\u0442\u0438 \u0432 \u0446\u044C\u043E\u043C\u0443 \u043F\u043E\u043B\u0456.",
        "zh-cn": "\u5982\u679C\u51FA\u73B0\u8FD0\u884C\u95EE\u9898\uFF08\u4F8B\u5982\u6E29\u5EA6\u4F20\u611F\u5668\u635F\u574F\uFF09\uFF0C\u53EF\u4EE5\u5728\u6B64\u5B57\u6BB5\u4E2D\u62A5\u544A\u3002"
      },
      type: "string",
      role: "state",
      read: true,
      write: false
    }
  },
  {
    id: "status.version",
    common: {
      name: {
        en: "API/Firmware version number",
        de: "API-/Firmwareversionsnummer",
        ru: "\u041D\u043E\u043C\u0435\u0440 \u0432\u0435\u0440\u0441\u0438\u0438 API/\u043F\u0440\u043E\u0448\u0438\u0432\u043A\u0438",
        pt: "N\xFAmero da vers\xE3o da API/firmware",
        nl: "API-/firmwareversienummer",
        fr: "Num\xE9ro de version de l\u2019API/du firmware",
        it: "Numero di versione API/firmware",
        es: "N\xFAmero de versi\xF3n de la API/firmware",
        pl: "Numer wersji API/oprogramowania uk\u0142adowego",
        uk: "\u041D\u043E\u043C\u0435\u0440 \u0432\u0435\u0440\u0441\u0456\u0457 API/\u043F\u0440\u043E\u0448\u0438\u0432\u043A\u0438",
        "zh-cn": "API/\u56FA\u4EF6\u7248\u672C\u53F7"
      },
      type: "string",
      role: "info.firmware",
      read: true,
      write: false
    }
  }
];
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEVICE_CHANNELS,
  DEVICE_STATES
});
//# sourceMappingURL=deviceStates.js.map
