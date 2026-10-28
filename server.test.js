"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");
const { createApplicationServer } = require("./server");

const servers = [];
const directories = [];

afterEach(async function() {
  await Promise.all(servers.splice(0).map(function(server) {
    return new Promise(function(resolve) {
      server.closeAllConnections();
      server.close(resolve);
    });
  }));
  directories.splice(0).forEach(function(directory) {
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

async function startServer(options) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "impresora-server-test-"));
  directories.push(dataDir);
  const server = createApplicationServer({
    dataDir,
    adminPassword: "test-admin-key",
    printDurationMs: options && options.printDurationMs || 20
  });
  servers.push(server);
  await new Promise(function(resolve) { server.listen(0, "127.0.0.1", resolve); });
  return { server, dataDir, baseUrl: "http://127.0.0.1:" + server.address().port };
}

function adminHeaders(extra) {
  return Object.assign({ "x-clave": "test-admin-key" }, extra || {});
}

async function json(response) {
  return response.json();
}

async function waitUntilReady(baseUrl, id) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(baseUrl + "/api/pedidos/" + id);
    const order = await json(response);
    if (order.estado === "listo") return order;
    await new Promise(function(resolve) { setTimeout(resolve, 10); });
  }
  throw new Error("El pedido no llegó al estado listo.");
}

test("sirve configuración y protege la administración", async function() {
  const { baseUrl } = await startServer();
  const config = await json(await fetch(baseUrl + "/api/config"));
  assert.equal(config.modo, "demo");
  assert.equal(config.impresoras["1"], "Impresora 1");
  assert.equal(Object.hasOwn(config, "tarjetasDemo"), false);
  assert.equal((await fetch(baseUrl + "/api/admin/pedidos")).status, 401);
  assert.equal((await fetch(baseUrl + "/")).status, 200);
  const stylesheet = await fetch(baseUrl + "/style.css");
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type"), /^text\/css/);
});

test("elimina los saldos de tarjetas heredados al iniciar", async function() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "impresora-server-test-"));
  directories.push(dataDir);
  const stateFile = path.join(dataDir, "database.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    printers: { "1": "Impresora 1" },
    orders: [],
    tarjetasDemo: { "DEMO-0001": 18800 }
  }));
  const server = createApplicationServer({
    dataDir,
    adminPassword: "test-admin-key",
    printDurationMs: 20
  });
  servers.push(server);
  await new Promise(function(resolve) { server.listen(0, "127.0.0.1", resolve); });

  assert.equal((await fetch("http://127.0.0.1:" + server.address().port + "/api/config")).status, 200);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(stateFile, "utf8")), "tarjetasDemo"), false);
});

test("usa la clave configurada en ADMIN_PASSWORD", async function() {
  const previousPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = "environment-admin-key";
  try {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "impresora-server-env-test-"));
    directories.push(dataDir);
    const server = createApplicationServer({ dataDir });
    servers.push(server);
    await new Promise(function(resolve) { server.listen(0, "127.0.0.1", resolve); });
    const baseUrl = "http://127.0.0.1:" + server.address().port;
    assert.equal((await fetch(baseUrl + "/api/admin/pedidos", {
      headers: { "x-clave": "environment-admin-key" }
    })).status, 200);
  } finally {
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousPassword;
  }
});

test("gestiona impresoras y el flujo de un pedido persistido", async function() {
  const { baseUrl, dataDir } = await startServer();
  let response = await fetch(baseUrl + "/api/admin/impresoras", {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ id: "mesa_2", nombre: "Impresora salón" })
  });
  assert.equal(response.status, 201);
  const config = await json(await fetch(baseUrl + "/api/config"));
  assert.equal(config.impresoras.mesa_2, "Impresora salón");
  response = await fetch(baseUrl + "/api/admin/impresoras/mesa_2", {
    method: "PUT",
    headers: adminHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ id: "mesa_2", nombre: "Impresora recepción" })
  });
  assert.equal(response.status, 200);

  const duplicate = await fetch(baseUrl + "/api/admin/impresoras", {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ id: "mesa_2", nombre: "Duplicada" })
  });
  assert.equal(duplicate.status, 409);

  const form = new FormData();
  form.append("impresora", "mesa_2");
  form.append("archivo", new Blob(["%PDF /Type /Page /Type /Page"], { type: "application/pdf" }), "prueba.pdf");
  response = await fetch(baseUrl + "/api/pedidos", { method: "POST", body: form });
  assert.equal(response.status, 200);
  const created = await json(response);
  assert.equal(created.paginas, 2);
  const pendingOrders = await json(await fetch(baseUrl + "/api/admin/pedidos", { headers: adminHeaders() }));
  assert.equal(pendingOrders.some(function(order) { return order.id === created.id; }), false);

  response = await fetch(baseUrl + "/api/pedidos/" + created.id + "/confirmar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ color: true, copias: 2, papel: "glossy", tamano: "A3" })
  });
  assert.equal(response.status, 400);

  response = await fetch(baseUrl + "/api/pedidos/" + created.id + "/confirmar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ color: true, copias: 2, papel: "fotografico", tamano: "A3" })
  });
  assert.equal(response.status, 200);
  assert.equal((await json(response)).total, 9600);

  response = await fetch(baseUrl + "/api/pedidos/" + created.id + "/pagar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      titular: "PERSONA FICTICIA",
      numero: "1234567890123456",
      vencimiento: "2099-12",
      codigo: "123"
    })
  });
  assert.equal(response.status, 200);
  assert.equal((await json(response)).modo, "demo");
  assert.equal((await waitUntilReady(baseUrl, created.id)).estado, "listo");
  const completedOrder = await json(await fetch(baseUrl + "/api/pedidos/" + created.id));
  assert.equal(completedOrder.papel, "fotografico");
  assert.equal(completedOrder.tamano, "A3");
  assert.equal(completedOrder.total, 9600);
  assert.equal(completedOrder.pagoConfirmado, true);
  assert.equal(completedOrder.hojasImpresas, 4);

  response = await fetch(baseUrl + "/api/admin/pedidos", { headers: adminHeaders() });
  assert.ok((await json(response)).some(function(order) { return order.id === created.id; }));

  response = await fetch(baseUrl + "/api/admin/pedidos/" + created.id + "/reimprimir", {
    method: "POST",
    headers: adminHeaders()
  });
  assert.equal(response.status, 200);
  assert.equal((await waitUntilReady(baseUrl, created.id)).estado, "listo");

  const basePaperForm = new FormData();
  basePaperForm.append("impresora", "mesa_2");
  basePaperForm.append("archivo", new Blob(["prueba"], { type: "text/plain" }), "base.txt");
  response = await fetch(baseUrl + "/api/pedidos", { method: "POST", body: basePaperForm });
  const basePaperOrder = await json(response);
  response = await fetch(baseUrl + "/api/pedidos/" + basePaperOrder.id + "/confirmar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ color: false, copias: 1, papel: "comun", tamano: "A4" })
  });
  assert.equal((await json(response)).total, 500);
  response = await fetch(baseUrl + "/api/pedidos/" + basePaperOrder.id + "/pagar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      titular: "OTRA PERSONA FICTICIA",
      numero: "9999888877776666",
      vencimiento: "2099-12",
      codigo: "9876"
    })
  });
  assert.equal(response.status, 200);
  assert.equal((await waitUntilReady(baseUrl, basePaperOrder.id)).estado, "listo");

  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "database.json"), "utf8"));
  assert.equal(stored.orders.find(function(order) { return order.id === created.id; }).total, 9600);
  assert.equal(fs.readdirSync(path.join(dataDir, "uploads")).length, 2);

  const restartedServer = createApplicationServer({ dataDir, adminPassword: "test-admin-key" });
  servers.push(restartedServer);
  await new Promise(function(resolve) { restartedServer.listen(0, "127.0.0.1", resolve); });
  const restartedUrl = "http://127.0.0.1:" + restartedServer.address().port;
  response = await fetch(restartedUrl + "/api/admin/pedidos", {
    headers: adminHeaders()
  });
  assert.ok((await json(response)).some(function(order) { return order.id === created.id; }));
  const persistedConfig = await json(await fetch(restartedUrl + "/api/config"));
  assert.equal(Object.hasOwn(persistedConfig, "tarjetasDemo"), false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dataDir, "database.json"), "utf8")), "tarjetasDemo"), false);

  response = await fetch(restartedUrl + "/api/admin/pedidos/" + created.id, {
    method: "DELETE",
    headers: adminHeaders()
  });
  assert.equal(response.status, 200);
  assert.equal((await fetch(restartedUrl + "/api/pedidos/" + created.id)).status, 404);
  response = await fetch(restartedUrl + "/api/admin/pedidos", { headers: adminHeaders() });
  assert.equal((await json(response)).some(function(order) { return order.id === created.id; }), false);

  response = await fetch(baseUrl + "/api/admin/impresoras/mesa_2", {
    method: "DELETE",
    headers: adminHeaders()
  });
  assert.equal(response.status, 200);
  response = await fetch(baseUrl + "/api/admin/impresoras/1", {
    method: "DELETE",
    headers: adminHeaders()
  });
  assert.equal(response.status, 409);
});

test("bloquea una impresora ocupada y publica su estado hasta terminar", async function() {
  const { baseUrl } = await startServer({ printDurationMs: 120 });
  async function createOrder(filename) {
    const form = new FormData();
    form.append("impresora", "1");
    form.append("archivo", new Blob(["prueba"], { type: "text/plain" }), filename);
    const created = await json(await fetch(baseUrl + "/api/pedidos", { method: "POST", body: form }));
    await fetch(baseUrl + "/api/pedidos/" + created.id + "/confirmar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: false, copias: 1 })
    });
    return created.id;
  }
  async function payOrder(id) {
    return fetch(baseUrl + "/api/pedidos/" + id + "/pagar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        titular: "TITULAR FICTICIO",
        numero: "1234567812345678",
        vencimiento: "2099-12",
        codigo: "123"
      })
    });
  }

  const firstOrder = await createOrder("primero.txt");
  const waitingOrder = await createOrder("segundo.txt");
  assert.equal((await payOrder(firstOrder)).status, 200);

  let config = await json(await fetch(baseUrl + "/api/config"));
  assert.equal(config.estadosImpresoras["1"], "imprimiendo");
  const adminPrinterState = await json(await fetch(baseUrl + "/api/admin/impresoras", {
    headers: adminHeaders()
  }));
  assert.equal(adminPrinterState.estadosImpresoras["1"], "imprimiendo");
  assert.equal((await payOrder(waitingOrder)).status, 409);

  const uploadWhileBusy = new FormData();
  uploadWhileBusy.append("impresora", "1");
  uploadWhileBusy.append("archivo", new Blob(["prueba"], { type: "text/plain" }), "tercero.txt");
  assert.equal((await fetch(baseUrl + "/api/pedidos", {
    method: "POST",
    body: uploadWhileBusy
  })).status, 409);
  assert.equal((await fetch(baseUrl + "/api/admin/pedidos/" + firstOrder + "/reimprimir", {
    method: "POST",
    headers: adminHeaders()
  })).status, 409);

  assert.equal((await waitUntilReady(baseUrl, firstOrder)).estado, "listo");
  config = await json(await fetch(baseUrl + "/api/config"));
  assert.equal(config.estadosImpresoras["1"], "disponible");
  assert.equal((await payOrder(waitingOrder)).status, 200);
  assert.equal((await waitUntilReady(baseUrl, waitingOrder)).estado, "listo");
});

test("libera impresoras de trabajos interrumpidos al reiniciar el servidor", async function() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "impresora-server-recovery-test-"));
  directories.push(dataDir);
  fs.writeFileSync(path.join(dataDir, "database.json"), JSON.stringify({
    printers: { "1": "Impresora 1" },
    orders: [{
      id: "interrupted-order",
      creado: new Date().toISOString(),
      impresora: "1",
      nombre: "documento.txt",
      paginas: 1,
      copias: 1,
      color: false,
      total: 500,
      pagoConfirmado: true,
      hojasImpresas: 0,
      estado: "imprimiendo",
      error: ""
    }]
  }));
  const server = createApplicationServer({ dataDir, adminPassword: "test-admin-key" });
  servers.push(server);
  await new Promise(function(resolve) { server.listen(0, "127.0.0.1", resolve); });
  const baseUrl = "http://127.0.0.1:" + server.address().port;

  const config = await json(await fetch(baseUrl + "/api/config"));
  const orders = await json(await fetch(baseUrl + "/api/admin/pedidos", { headers: adminHeaders() }));
  assert.equal(config.estadosImpresoras["1"], "disponible");
  assert.equal(orders[0].estado, "error");
  assert.match(orders[0].error, /interrumpió al reiniciar/);
});

test("rechaza extensiones no permitidas e impresoras inexistentes", async function() {
  const { baseUrl } = await startServer();
  const unsupported = new FormData();
  unsupported.append("impresora", "1");
  unsupported.append("archivo", new Blob(["no"], { type: "text/plain" }), "script.exe");
  assert.equal((await fetch(baseUrl + "/api/pedidos", { method: "POST", body: unsupported })).status, 415);

  const unknownPrinter = new FormData();
  unknownPrinter.append("impresora", "missing");
  unknownPrinter.append("archivo", new Blob(["hello"], { type: "text/plain" }), "hello.txt");
  assert.equal((await fetch(baseUrl + "/api/pedidos", { method: "POST", body: unknownPrinter })).status, 400);

  const reservedId = await fetch(baseUrl + "/api/admin/impresoras", {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ id: "__proto__", nombre: "Inválida" })
  });
  assert.equal(reservedId.status, 400);
});

test("limita la capacidad de cada pedido a 350 hojas y a cuatro impresoras", async function() {
  const { baseUrl } = await startServer();
  for (let index = 2; index <= 4; index += 1) {
    const response = await fetch(baseUrl + "/api/admin/impresoras", {
      method: "POST",
      headers: adminHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ id: "printer_" + index, nombre: "Impresora " + index })
    });
    assert.equal(response.status, 201);
  }
  const fifthPrinter = await fetch(baseUrl + "/api/admin/impresoras", {
    method: "POST",
    headers: adminHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ id: "printer_5", nombre: "Impresora 5" })
  });
  assert.equal(fifthPrinter.status, 409);

  const upload = new FormData();
  upload.append("impresora", "1");
  upload.append("archivo", new Blob([Array(350).fill("/Type /Page").join(" ")], { type: "application/pdf" }), "350-paginas.pdf");
  const createdResponse = await fetch(baseUrl + "/api/pedidos", { method: "POST", body: upload });
  assert.equal(createdResponse.status, 200);
  const created = await json(createdResponse);

  const tooManyCopies = await fetch(baseUrl + "/api/pedidos/" + created.id + "/confirmar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ color: false, copias: 2 })
  });
  assert.equal(tooManyCopies.status, 400);

  const exactlyAtCapacity = await fetch(baseUrl + "/api/pedidos/" + created.id + "/confirmar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ color: false, copias: 1 })
  });
  assert.equal(exactlyAtCapacity.status, 200);

  const oversizedUpload = new FormData();
  oversizedUpload.append("impresora", "1");
  oversizedUpload.append("archivo", new Blob([Array(351).fill("/Type /Page").join(" ")], { type: "application/pdf" }), "351-paginas.pdf");
  const oversizedResponse = await fetch(baseUrl + "/api/pedidos", { method: "POST", body: oversizedUpload });
  assert.equal(oversizedResponse.status, 400);
});

test("no limita el pago ficticio por un saldo de tarjeta", async function() {
  const { baseUrl } = await startServer();
  const form = new FormData();
  form.append("impresora", "1");
  form.append("archivo", new Blob([Array(1845).fill("linea").join("\n")], { type: "text/plain" }), "saldo-insuficiente.txt");
  const createdResponse = await fetch(baseUrl + "/api/pedidos", { method: "POST", body: form });
  assert.equal(createdResponse.status, 200);
  const created = await json(createdResponse);
  assert.equal(created.paginas, 41);

  const confirmResponse = await fetch(baseUrl + "/api/pedidos/" + created.id + "/confirmar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ color: false, copias: 1, papel: "comun", tamano: "A4" })
  });
  assert.equal((await json(confirmResponse)).total, 20500);

  const paymentResponse = await fetch(baseUrl + "/api/pedidos/" + created.id + "/pagar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      titular: "PERSONA FICTICIA",
      numero: "1234567890123456",
      vencimiento: "2099-12",
      codigo: "123"
    })
  });
  assert.equal(paymentResponse.status, 200);
  const paidOrder = await json(await fetch(baseUrl + "/api/pedidos/" + created.id));
  assert.equal(paidOrder.pagoConfirmado, true);
  assert.notEqual(paidOrder.estado, "cancelado");

  const adminOrders = await json(await fetch(baseUrl + "/api/admin/pedidos", { headers: adminHeaders() }));
  assert.equal(adminOrders.some(function(order) { return order.id === created.id; }), true);
});

test("pide datos ficticios válidos en cada pago sin guardarlos", async function() {
  const { baseUrl, dataDir } = await startServer();
  const form = new FormData();
  form.append("impresora", "1");
  form.append("archivo", new Blob(["hola"], { type: "text/plain" }), "prueba.txt");
  const uploadResponse = await fetch(baseUrl + "/api/pedidos", { method: "POST", body: form });
  const order = await json(uploadResponse);
  await fetch(baseUrl + "/api/pedidos/" + order.id + "/confirmar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ color: false, copias: 1, papel: "comun", tamano: "A4" })
  });

  const invalidCard = await fetch(baseUrl + "/api/pedidos/" + order.id + "/pagar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ numero: "1234567812345678" })
  });
  assert.equal(invalidCard.status, 400);
  assert.equal((await json(await fetch(baseUrl + "/api/pedidos/" + order.id))).estado, "esperando_pago");

  const payment = await fetch(baseUrl + "/api/pedidos/" + order.id + "/pagar", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      titular: "TITULAR FICTICIO",
      numero: "1234567812345678",
      vencimiento: "2099-12",
      codigo: "123"
    })
  });
  assert.equal(payment.status, 200);
  assert.equal((await waitUntilReady(baseUrl, order.id)).estado, "listo");

  const state = JSON.parse(fs.readFileSync(path.join(dataDir, "database.json"), "utf8"));
  assert.equal(Object.hasOwn(state, "tarjetasDemo"), false);
  assert.equal(JSON.stringify(state).includes("1234567812345678"), false);
  assert.equal(JSON.stringify(state).includes("TITULAR FICTICIO"), false);
});

test("valida titular solo con letras y tarjetas de 12 a 19 dígitos", async function() {
  const { baseUrl } = await startServer();
  async function createOrder(filename) {
    const form = new FormData();
    form.append("impresora", "1");
    form.append("archivo", new Blob(["hola"], { type: "text/plain" }), filename);
    const order = await json(await fetch(baseUrl + "/api/pedidos", { method: "POST", body: form }));
    await fetch(baseUrl + "/api/pedidos/" + order.id + "/confirmar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ color: false, copias: 1, papel: "comun", tamano: "A4" })
    });
    return order.id;
  }
  async function pay(id, titular, numero) {
    return fetch(baseUrl + "/api/pedidos/" + id + "/pagar", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        titular,
        numero,
        vencimiento: "2099-12",
        codigo: "123"
      })
    });
  }

  const twelveDigitOrder = await createOrder("doce-digitos.txt");
  assert.equal((await pay(twelveDigitOrder, "María Pérez", "12345678901")).status, 400);
  assert.equal((await pay(twelveDigitOrder, "María Pérez", "123456789012")).status, 200);
  await waitUntilReady(baseUrl, twelveDigitOrder);

  const nineteenDigitOrder = await createOrder("diecinueve-digitos.txt");
  assert.equal((await pay(nineteenDigitOrder, "María Pérez2", "1234567890123456789")).status, 400);
  assert.equal((await pay(nineteenDigitOrder, "María Pérez", "12345678901234567890")).status, 400);
  assert.equal((await pay(nineteenDigitOrder, "María Pérez", "123456789012345678a")).status, 400);
  assert.equal((await pay(nineteenDigitOrder, "María Pérez", "1234567890123456789")).status, 200);
});
