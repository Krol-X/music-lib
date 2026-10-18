/**
 * TypeBox для Elysia — подключаем явно, статическим импортом.
 *
 * Elysia по умолчанию берёт TypeBox синхронным require'ом в рантайме
 * (`require("typebox/type")`). Для запуска из исходников это работает, но
 * бандлер такой вызов не разбирает, и в прод-бинарнике (bun build --compile)
 * сервер падал на старте с «Cannot find module 'typebox/type'».
 *
 * `setupTypebox` делает то же самое, но связкой, известной бандлеру на этапе
 * сборки: модуль попадает в граф импортов и встраивается в бинарник.
 *
 * Порядок импортов важен: модуль с побочным эффектом должен грузиться ДО
 * `src/app.ts`, потому что схемы (`t.Object(...)`) строятся прямо в теле
 * app.ts, и TypeBox нужен к этому моменту уже подключённым.
 */
import { setupTypebox } from "elysia";
import * as type from "typebox/type";
import * as system from "typebox/system";

setupTypebox({ typebox: { type, system } });