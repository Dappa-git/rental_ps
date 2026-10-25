CREATE DATABASE IF NOT EXISTS rental_ps CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE rental_ps;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(200) NOT NULL,
  name VARCHAR(80) NOT NULL,
  role ENUM('user','admin') NOT NULL DEFAULT 'user',
  saldo_detik INT NOT NULL DEFAULT 0,          -- sisa waktu tersimpan (stop manual)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rentals (
  id VARCHAR(36) PRIMARY KEY,
  tv_id VARCHAR(10) NOT NULL,
  console VARCHAR(10),
  user_id INT NOT NULL,
  pkg VARCHAR(10) NOT NULL,                    -- demo | jam1 | jam2 | lepas | saldo
  status ENUM('active','cleaning','paid') NOT NULL,
  start_at BIGINT NOT NULL,                    -- epoch ms
  end_at BIGINT NULL,                          -- NULL = main lepas
  duration INT NULL,                           -- detik
  stop_at BIGINT NULL,                         -- terisi jika stop manual
  paid_at BIGINT NULL,
  bill_rental INT NOT NULL DEFAULT 0,
  sisa_detik INT NOT NULL DEFAULT 0,           -- sisa waktu yang disimpan ke akun
  INDEX idx_tv_status (tv_id, status),
  INDEX idx_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS rental_fnb (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rental_id VARCHAR(36) NOT NULL,
  item VARCHAR(60) NOT NULL,
  price INT NOT NULL,
  FOREIGN KEY (rental_id) REFERENCES rentals(id) ON DELETE CASCADE
);
-- Akun admin (admin1234 / kelompok10) dibuat otomatis oleh server.js saat pertama dijalankan.
