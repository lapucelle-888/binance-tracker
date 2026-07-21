# CLAUDE.md

Panduan kerja untuk Claude Code di repo ini.

## ⚠️ Konteks kritis

Ini adalah **tracker Binance Futures LIVE dengan uang sungguhan**. Bukan sandbox,
bukan testnet. Setiap kesalahan bisa berdampak finansial nyata. Selalu ekstra
hati-hati, pelan, dan konservatif — terutama pada logika yang menyentuh posisi,
order, saldo, atau kredensial API.

## Aturan wajib

- **Selalu jalankan `node --check index.js` sebelum restart service apapun.**
  Ini adalah syntax check minimum untuk memastikan tidak ada error fatal sebelum
  service dijalankan ulang.
- **`index.html` tidak butuh restart service.** Cukup refresh browser untuk
  melihat perubahan — jangan restart service hanya karena perubahan di file ini.
- **Jangan pernah restart service.** Restart dilakukan manual oleh user setelah
  user sendiri yang mencoba/mengetes perubahannya. Jangan jalankan perintah
  restart/start/stop service atas inisiatif sendiri.
- **Jangan pernah membaca, menulis, atau menampilkan isi file `.env`** dengan
  alasan apapun — termasuk untuk debugging, verifikasi, atau menampilkan ke
  user. File ini berisi kredensial API Binance live.
- **Semua teks UI harus dalam bahasa Inggris** (label, tombol, pesan error,
  notifikasi, dll), meskipun percakapan dengan user boleh dalam bahasa lain.
- **Perubahan harus kecil dan scoped per task.** Jangan melakukan refactor besar,
  perubahan struktur, atau "sambil beresin" yang tidak diminta secara eksplisit.
- **Tunjukkan diff/perubahan dulu sebelum diterapkan.** Jelaskan apa yang akan
  diubah dan kenapa, baru terapkan ke file setelah jelas — jangan langsung
  menimpa file tanpa preview terlebih dahulu.

## Catatan teknis penting

- Sejak Desember 2025, conditional order `STOP_MARKET`/`TAKE_PROFIT_MARKET`
  **tidak lagi diterima** di endpoint `/fapi/v1/order`. Wajib menggunakan
  `/fapi/v1/algoOrder` dengan `algoType: "CONDITIONAL"` dan `triggerPrice`.
  Response akan berisi `algoId` (bukan `orderId`).
- Setelah melakukan full-replace pada `index.html`, wajib verifikasi dengan:
  - `tail -3 public/index.html` — harus diakhiri `</script>`, `</body>`, `</html>`.
  - `grep -c "setMarginPct" public/index.html` — hasil harus `5`.
- App berjalan sebagai systemd service bernama **`tracker`** di port **8000**,
  di belakang **Caddy** sebagai reverse proxy. Secrets dimuat lewat
  `--env-file=.env`.
