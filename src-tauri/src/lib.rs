#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri_plugin_sql::{Migration, MigrationKind};

    let migrations = vec![Migration {
        version: 1,
        description: "create_vecstructi_document_schema",
        sql: r#"
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                width_um INTEGER NOT NULL,
                height_um INTEGER NOT NULL,
                unit TEXT NOT NULL DEFAULT 'px',
                precision INTEGER NOT NULL DEFAULT 1,
                background TEXT NOT NULL DEFAULT '#ffffff',
                background_transparent INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS document_settings (
                document_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value_json TEXT NOT NULL,
                PRIMARY KEY (document_id, key),
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS layers (
                document_id TEXT NOT NULL,
                name TEXT NOT NULL,
                position INTEGER NOT NULL,
                visible INTEGER NOT NULL DEFAULT 1,
                locked INTEGER NOT NULL DEFAULT 0,
                opacity INTEGER NOT NULL DEFAULT 100,
                PRIMARY KEY (document_id, name),
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS objects (
                document_id TEXT NOT NULL,
                uid TEXT NOT NULL,
                type TEXT NOT NULL,
                layer_name TEXT NOT NULL,
                z_index INTEGER NOT NULL,
                x_um INTEGER NOT NULL DEFAULT 0,
                y_um INTEGER NOT NULL DEFAULT 0,
                w_um INTEGER NOT NULL DEFAULT 0,
                h_um INTEGER NOT NULL DEFAULT 0,
                rotation_mdeg INTEGER NOT NULL DEFAULT 0,
                stroke TEXT NOT NULL DEFAULT '',
                fill TEXT NOT NULL DEFAULT 'none',
                stroke_w_um INTEGER NOT NULL DEFAULT 0,
                stroke_dash TEXT NOT NULL DEFAULT '',
                locked INTEGER NOT NULL DEFAULT 0,
                group_id TEXT,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (document_id, uid),
                FOREIGN KEY (document_id, layer_name) REFERENCES layers(document_id, name) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_objects_document_z
                ON objects(document_id, z_index);

            CREATE TABLE IF NOT EXISTS object_points (
                document_id TEXT NOT NULL,
                object_uid TEXT NOT NULL,
                point_index INTEGER NOT NULL,
                x_um INTEGER NOT NULL,
                y_um INTEGER NOT NULL,
                t_ms INTEGER,
                PRIMARY KEY (document_id, object_uid, point_index),
                FOREIGN KEY (document_id, object_uid) REFERENCES objects(document_id, uid) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id TEXT NOT NULL,
                label TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                undone_at TEXT,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS transaction_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                transaction_id INTEGER NOT NULL,
                step_index INTEGER NOT NULL,
                action TEXT NOT NULL,
                object_uid TEXT,
                before_json TEXT,
                after_json TEXT,
                FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
            );
        "#,
        kind: MigrationKind::Up,
    }, Migration {
        version: 2,
        description: "create_shapes_table",
        sql: r#"
            CREATE TABLE IF NOT EXISTS shapes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                gruppe TEXT NOT NULL DEFAULT '',
                objects_json TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        "#,
        kind: MigrationKind::Up,
    }, Migration {
        version: 3,
        description: "add_preview_svg_to_shapes",
        sql: r#"
            ALTER TABLE shapes ADD COLUMN preview_svg TEXT NOT NULL DEFAULT '';
        "#,
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:vecstructi.db", migrations)
                .add_migrations("sqlite:vecstructi_shapes.db", vec![
                    Migration {
                        version: 1,
                        description: "create_shapes_table",
                        sql: r#"
                            CREATE TABLE IF NOT EXISTS shapes (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                name TEXT NOT NULL,
                                gruppe TEXT NOT NULL DEFAULT '',
                                objects_json TEXT NOT NULL,
                                preview_svg TEXT NOT NULL DEFAULT '',
                                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                            );
                        "#,
                        kind: MigrationKind::Up,
                    }
                ])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
