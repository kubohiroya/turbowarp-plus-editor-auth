import {defineConfig} from 'vite';

export default defineConfig({
    build: {
        target: 'es2017',
        lib: {entry: 'src/index.ts', formats: ['es'], fileName: () => 'index.js'}
    }
});
