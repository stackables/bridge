# Dependency emulator — nginx serving static JSON fixtures.
#
# Simulates an external REST API with zero compute cost.
# Endpoints: /api/simple, /api/list, /api/catalog, /api/variant/{1..10}

FROM nginx:1-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY data/ /data/

EXPOSE 8080
