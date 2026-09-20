export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.pathname === "/health" ||
      url.pathname === "/requests" ||
      url.pathname.startsWith("/requests/") ||
      url.pathname === "/admin/apply"
    ) {
      return env.API.fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
