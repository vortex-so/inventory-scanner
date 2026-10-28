// One entry per unit: a unit is one Google Sheet plus the Apps Script bound to it.
// apiUrl is the script's web-app URL (ends in /exec) from apps-script/README steps.
// With one unit the login screen shows no selector; with several it asks which unit.
// Leave the list empty and the app shows the setup instructions instead of a login screen.
window.APP_CONFIG = {
  appName: 'Vortex Inventory',
  units: [
    // Bagas's sheet "Database Inventory Vortex Media" (owner produksions@gmail.com), script deployed by
    // abriele@vortex.so on 28 Okt 2026. The test sheet "Vortex Inventory Test" is no longer listed.
    { key: 'media', name: 'Vortex Media', apiUrl: 'https://script.google.com/macros/s/AKfycbxBcRb5ZOhYw4dpGHbBYR5EucApUBKC5jDi98oivnyZNlsVan9CXUjD9wQ-YtQcxp1w0g/exec' },
    // { key: 'kptj',  name: 'KPTJ',         apiUrl: 'https://script.google.com/macros/s/YYYYYYYY/exec' }
  ]
};
