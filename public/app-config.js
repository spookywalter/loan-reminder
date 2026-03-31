(function () {
  var localhostApiOrigin = 'http://localhost:5000';
  var currentOrigin = window.location.origin;
  var isLocalhost = /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);
  var apiBaseUrl = isLocalhost ? localhostApiOrigin : currentOrigin;
  var originalFetch = window.fetch.bind(window);

  window.API_BASE_URL = apiBaseUrl;

  window.fetch = function (input, init) {
    if (typeof input === 'string') {
      if (input.startsWith('/')) {
        input = apiBaseUrl + input;
      } else if (input.startsWith(localhostApiOrigin)) {
        input = apiBaseUrl + input.slice(localhostApiOrigin.length);
      }
    }

    return originalFetch(input, init);
  };
})();
