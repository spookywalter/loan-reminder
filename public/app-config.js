(function () {
  var isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  var localApiBaseUrl = 'http://localhost:5000';
  var apiBaseUrl = isLocalHost ? localApiBaseUrl : window.location.origin;
  var originalFetch = window.fetch.bind(window);

  window.API_BASE_URL = apiBaseUrl;

  window.fetch = function (input, init) {
    if (typeof input === 'string' && input.indexOf(localApiBaseUrl) === 0) {
      input = apiBaseUrl + input.slice(localApiBaseUrl.length);
    }

    return originalFetch(input, init);
  };
})();
