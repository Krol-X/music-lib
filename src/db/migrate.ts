import { db } from "./index.js";

const [, applied] = await db.migrate.latest();

console.log(
  applied.length > 0 ? `Применено: ${applied.join(", ")}` : "Новых миграций нет",
);

await db.destroy();
