# Database connection settings (advisory database).
# Review copy: the real host / user / password are NOT included. With these values the connection simply fails and
# the Home page works without the advisory history (see get_vaa_history in volcano_data.py: it returns [] after 4 s).
DB_HOST = "127.0.0.1"
DB_PORT = 3306
DB_NAME = "VAAC"
DB_USER = "user"
DB_PASS = "password"
