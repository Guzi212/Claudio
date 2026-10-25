// 换完 cookie 后从地址栏去掉 token，保留 view 等其它参数。
export function urlWithoutToken(href) {
  const url = new URL(href, 'http://127.0.0.1');
  url.searchParams.delete('token');
  return `${url.pathname}${url.search}${url.hash}`;
}
