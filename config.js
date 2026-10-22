// One entry per unit: a unit is one Google Sheet plus the Apps Script bound to it.
// apiUrl is the script's web-app URL (ends in /exec) from apps-script/README steps.
// With one unit the login screen shows no selector; with several it asks which unit.
// Leave the list empty and the app shows the setup instructions instead of a login screen.
window.APP_CONFIG = {
  appName: 'Vortex Inventory',
  units: [
    // Test sheet "Vortex Inventory Test" in abriele@vortex.so's My Drive, deployed 22 Okt 2026. Replace with the real sheet when Bagas's data moves in.
    { key: 'test', name: 'Vortex Inventory (uji)', apiUrl: 'https://script.google.com/macros/s/AKfycbzlqhRurr5kBUQakk8-w378CIk8vKstxq-TCR3-f7WnIHLOo2copWyv3YJ8H0UZ0kJm/exec' },
    // { key: 'media', name: 'Vortex Media', apiUrl: 'https://script.google.com/macros/s/XXXXXXXX/exec' },
    // { key: 'kptj',  name: 'KPTJ',         apiUrl: 'https://script.google.com/macros/s/YYYYYYYY/exec' }
  ]
};
