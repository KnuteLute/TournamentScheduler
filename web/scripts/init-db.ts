import { Client } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const createTables = async () => {
    const client = new Client({
        connectionString: process.env.POSTGRES_URL,
    });

    try {
        await client.connect();
        console.log('Connected to PostgreSQL database');

        // Create Users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Users table created.');

        // Create Players table (guests vs users)
        await client.query(`
            CREATE TABLE IF NOT EXISTS players (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                guest_session_id VARCHAR(255),
                name VARCHAR(255) NOT NULL,
                games_played INTEGER DEFAULT 0,
                wins INTEGER DEFAULT 0,
                losses INTEGER DEFAULT 0,
                draws INTEGER DEFAULT 0,
                points_for INTEGER DEFAULT 0,
                points_against INTEGER DEFAULT 0,
                diff INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Players table created.');

        // Create Tournaments table
        await client.query(`
            CREATE TABLE IF NOT EXISTS tournaments (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                guest_session_id VARCHAR(255),
                mode VARCHAR(255),
                date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                standings JSONB
            );
        `);
        console.log('Tournaments table created.');

        // Create Matches table
        await client.query(`
            CREATE TABLE IF NOT EXISTS matches (
                id SERIAL PRIMARY KEY,
                tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                guest_session_id VARCHAR(255),
                teams JSONB NOT NULL,
                status VARCHAR(50),
                start_time TIMESTAMP,
                end_time TIMESTAMP,
                mode VARCHAR(255),
                round INTEGER,
                court INTEGER
            );
        `);
        console.log('Matches table created.');

        console.log('Database initialization successful!');
    } catch (e) {
        console.error('Database initialization failed:', e);
    } finally {
        await client.end();
    }
};

createTables();
