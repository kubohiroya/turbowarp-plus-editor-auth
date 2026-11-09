import {defineConfig} from 'vite';

export default defineConfig({
    build: {
        target: 'es2017',
        license: {fileName: 'THIRD_PARTY_NOTICES.md'},
        lib: {entry: 'src/index.ts', formats: ['es'], fileName: () => 'index.js'}
    }
});
