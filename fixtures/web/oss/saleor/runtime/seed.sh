#!/bin/sh
set -eu

python manage.py migrate --noinput
python manage.py populatedb --createsuperuser
python manage.py shell <<'PY'
from django.contrib.auth import get_user_model
from saleor.permission.models import Permission

for name in ("maya", "jordan"):
    user, created = get_user_model().objects.get_or_create(
        email=f"{name}@example.test",
        defaults={"first_name": name.title(), "is_active": True, "is_staff": True, "is_confirmed": True},
    )
    if created:
        user.set_password("momentic-eval-1")
        user.save()
    user.user_permissions.set(Permission.objects.all())
PY
touch /tmp/saleor-setup-complete

while :; do
  sleep 3600
done
