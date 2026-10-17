/**
 * Единый формат ошибки для всех маршрутов: JSON {"error": "..."}.
 *
 * И буду честен: пока это был набор точечных Response(...) с повторяющимся
 * заголовком в трёх местах, и каждый новый route рисковал внести свой формат.
 * Теперь один хелпер — и тесты проверяют именно его.
 */
export function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
