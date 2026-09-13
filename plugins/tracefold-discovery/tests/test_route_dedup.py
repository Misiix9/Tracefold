from app.analyzer import crawl_route_key, normalize_path

def test_opaque_ids_are_normalized():
    assert normalize_path('/cmdb/entity-types/DAM000000558/index') == '/cmdb/entity-types/{id}/index'
    assert normalize_path('/cmdb/entity-types/DAM000000999/index') == '/cmdb/entity-types/{id}/index'

def test_route_query_values_can_collapse():
    assert crawl_route_key('https://example.test/items/123?filter=one') == '/items/{id}?filter={value}'
    assert crawl_route_key('https://example.test/items/456?filter=two') == '/items/{id}?filter={value}'

def test_custom_pattern_is_supported():
    assert normalize_path('/asset/ZZ-123456/view', [r'ZZ-\d+']) == '/asset/{id}/view'
