(function () {
  var apiBaseUrl = 'http://localhost:5000';
  var originalFetch = window.fetch.bind(window);

  window.API_BASE_URL = apiBaseUrl;

  window.fetch = function (input, init) {
    // Always use API_BASE_URL for API calls
    if (typeof input === 'string' && input.startsWith('/api/')) {
      input = apiBaseUrl + input;
    }
    
    return originalFetch(input, init);
  };
})();
