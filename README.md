# Servidor de Imprimir aquí

## Requisitos

- Node.js 20 o posterior.
- No requiere instalar paquetes adicionales.

## Iniciar en Windows

Abre PowerShell en esta carpeta y configura una clave de administración de al menos 16 caracteres:

```powershell
$env:ADMIN_PASSWORD = "una-clave-larga-y-unica-de-al-menos-16"
node server.js
```

Luego abre <http://127.0.0.1:3000>. El panel está en `/admin.html`.

La clave se valida usando scrypt con salt aleatorio, no se guarda en `database.json` ni queda expuesta como propiedad del servidor. Si no configuras `ADMIN_PASSWORD`, se genera una clave aleatoria y se muestra una sola vez en la terminal; cambia al reiniciar. El servidor limita los intentos fallidos y escucha por defecto solo en `127.0.0.1`.

Puedes cambiar el puerto con `PORT` y la interfaz de red con `HOST`. No expongas el servidor directamente a una red usando HTTP: la clave viajaría sin cifrar. Para permitir acceso desde otros equipos, ponlo detrás de un proxy HTTPS y limita el acceso a la red de confianza. Mantén también `data/` accesible solo para la cuenta que ejecuta el servidor; allí se guardan pedidos y documentos cargados.

## Qué incluye

- Sirve la página de impresión, su redirección anterior y el panel.
- Guarda pedidos, estado de impresoras y archivos subidos en `data/`.
- Marca cada impresora como ocupada mientras imprime; las demás pestañas actualizan su disponibilidad y no permiten iniciar otro trabajo en esa impresora hasta que termine.
- Permite consultar compras pagadas, eliminarlas y reimprimirlas desde el panel.
- Permite cambiar los precios base de blanco y negro y color desde la pestaña Precios del panel.
- Permite configurar hasta 4 impresoras, limita cada pedido a 350 hojas y simula la impresión hoja por hoja (hasta 5 segundos por hoja).
- Permite imprimir todas las páginas o indicar páginas y rangos (por ejemplo, `1,3-5`) y escribir directamente el número de copias.
- Ofrece papel común o fotográfico y tamaños A4 o A3; conserva las opciones de blanco y negro y color.
- Usa como base los precios existentes para papel común A4; fotográfico duplica el precio y A3 lo duplica nuevamente.
- Usa los endpoints `/api/config`, `/api/pedidos` y `/api/admin/...`.
- Acepta PDF, imágenes, texto y formatos comunes de Office/OpenDocument de hasta 50 MB.

Los datos y archivos quedan en `data/`; haz una copia de seguridad de esa carpeta si necesitas conservarlos. Los documentos subidos no se borran automáticamente.

## Límites de esta versión

Los pagos y la impresión son de demostración: cada compra pide los datos de una tarjeta ficticia, no se cobra dinero y los datos ingresados no se guardan. No ingreses datos de una tarjeta real. Solo los pedidos pagados aparecen en compras. Tampoco se envían trabajos a una impresora física. Para cobrar de verdad hace falta integrar un proveedor de pagos con un checkout seguro; para imprimir físicamente hace falta configurar el controlador y el servicio de impresión de los equipos.

## Pruebas

```powershell
node --test
```

## Integrantes

Santi Cabrera
Carla Olivera
Maxi    Godoy