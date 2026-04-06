'use strict';

const { generateApiDocs, generateMarkdown, generateOpenApiSpec } = require('../../src/api-docs');

describe('API-Docs Unit Tests', () => {
  let docs;

  beforeAll(() => {
    docs = generateApiDocs();
  });

  test('generateApiDocs() gibt ein Objekt mit allen Kategorien zurueck', () => {
    expect(docs).toHaveProperty('categories');
    const expectedCategories = [
      'Core', 'Agents', 'Config', 'Projects', 'Queue',
      'Export', 'Templates', 'Webhooks', 'Budget', 'Recovery',
      'Roles', 'Plan', 'Metrics', 'Logs', 'Milestones', 'Docs'
    ];
    for (const cat of expectedCategories) {
      expect(docs.categories).toHaveProperty(cat);
    }
  });

  test('Jeder Endpoint hat method, path und description', () => {
    const categories = docs.categories;
    for (const catName of Object.keys(categories)) {
      for (const ep of categories[catName]) {
        expect(ep).toHaveProperty('method');
        expect(ep).toHaveProperty('path');
        expect(ep).toHaveProperty('description');
        expect(typeof ep.method).toBe('string');
        expect(typeof ep.path).toBe('string');
        expect(typeof ep.description).toBe('string');
        expect(ep.method.length).toBeGreaterThan(0);
        expect(ep.path.length).toBeGreaterThan(0);
        expect(ep.description.length).toBeGreaterThan(0);
      }
    }
  });

  test('Jeder Endpoint hat parameters und responses', () => {
    const categories = docs.categories;
    for (const catName of Object.keys(categories)) {
      for (const ep of categories[catName]) {
        expect(ep).toHaveProperty('parameters');
        expect(ep).toHaveProperty('responses');
      }
    }
  });

  test('Jeder Endpoint hat ein example-Feld', () => {
    const categories = docs.categories;
    for (const catName of Object.keys(categories)) {
      for (const ep of categories[catName]) {
        expect(ep).toHaveProperty('example');
        expect(typeof ep.example).toBe('string');
      }
    }
  });

  test('Mindestens 60 Endpoints sind dokumentiert', () => {
    let count = 0;
    for (const catName of Object.keys(docs.categories)) {
      count += docs.categories[catName].length;
    }
    expect(count).toBeGreaterThanOrEqual(60);
  });

  test('generateMarkdown() gibt einen String mit allen Endpoints zurueck', () => {
    const md = generateMarkdown();
    expect(typeof md).toBe('string');
    expect(md.length).toBeGreaterThan(100);
    // Alle Kategorien muessen im Markdown vorkommen
    for (const catName of Object.keys(docs.categories)) {
      expect(md).toContain(catName);
    }
    // Stichproben-Endpoints pruefen
    expect(md).toContain('/api/status');
    expect(md).toContain('/api/start');
    expect(md).toContain('/api/webhooks');
    expect(md).toContain('/api/projects');
    expect(md).toContain('/api/config');
  });

  test('generateOpenApiSpec() hat korrektes OpenAPI 3.0 Format', () => {
    const spec = generateOpenApiSpec();
    expect(spec).toHaveProperty('openapi');
    expect(spec.openapi).toMatch(/^3\.0/);
    expect(spec).toHaveProperty('info');
    expect(spec.info).toHaveProperty('title');
    expect(spec.info).toHaveProperty('version');
    expect(spec).toHaveProperty('paths');
    expect(typeof spec.paths).toBe('object');
    // Mindestens einige Pfade muessen vorhanden sein
    const pathKeys = Object.keys(spec.paths);
    expect(pathKeys.length).toBeGreaterThanOrEqual(30);
  });

  test('OpenAPI-Spec enthaelt korrekte HTTP-Methoden', () => {
    const spec = generateOpenApiSpec();
    const validMethods = ['get', 'post', 'put', 'delete', 'patch'];
    for (const pathKey of Object.keys(spec.paths)) {
      for (const method of Object.keys(spec.paths[pathKey])) {
        expect(validMethods).toContain(method);
      }
    }
  });

  test('OpenAPI-Spec Pfade enthalten keine Express-Syntax', () => {
    const spec = generateOpenApiSpec();
    for (const pathKey of Object.keys(spec.paths)) {
      // Keine :param Syntax, sondern {param}
      expect(pathKey).not.toMatch(/:[a-zA-Z]/);
    }
  });

  test('Docs enthalt title, version und description', () => {
    expect(docs).toHaveProperty('title');
    expect(docs).toHaveProperty('version');
    expect(docs).toHaveProperty('description');
    expect(typeof docs.title).toBe('string');
    expect(typeof docs.version).toBe('string');
    expect(typeof docs.description).toBe('string');
  });
});
