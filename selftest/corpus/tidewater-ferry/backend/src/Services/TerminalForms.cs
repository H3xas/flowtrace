using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Tidewater.Ferry.Access;
using Tidewater.Ferry.Models;

namespace Tidewater.Ferry.Services
{
    public class TerminalForms
    {
        private readonly IPassengerAccess _access;

        public TerminalForms(IPassengerAccess access)
        {
            _access = access;
        }

        public async Task GuardForms(PassengerRequest request, bool permit)
        {
            if (permit)
            {
                await _access.ResolveIdentityAsync(request);
            }
            else
            {
                await _access.ReadIdentityAsync(request);
            }
        }

        public async Task<int> SwitchForm(PassengerRequest request, int kind)
        {
            switch (kind)
            {
                case 1:
                    await _access.ResolveIdentityAsync(request);
                    break;
                default:
                    await _access.ReadIdentityAsync(request);
                    break;
            }

            return kind;
        }

        public async Task TryForm(PassengerRequest request)
        {
            try
            {
                await _access.ResolveIdentityAsync(request);
            }
            catch (Exception)
            {
                await _access.ReadIdentityAsync(request);
            }
            finally
            {
                await _access.LoadPermitsAsync(request);
            }
        }

        public async Task ConditionalForm(PassengerRequest request, bool flag)
        {
            var first = flag ? _access.ResolveIdentityAsync(request) : _access.ReadIdentityAsync(request);
            var second = flag && request.LoadPermits ? _access.LoadPermitsAsync(request) : Task.CompletedTask;
            var third = request.PassengerId ?? (await _access.ReadIdentityAsync(request)).PassengerId;
            var fourth = flag switch
            {
                true => await _access.LoadPermitsAsync(request),
                false => await _access.ReadIdentityAsync(request),
            };
            await first;
            await second;
        }

        public async Task LoopForms(PassengerRequest request, IReadOnlyList<PassengerRequest> queue)
        {
            for (var index = 0; index < request.TicketCount; index++)
            {
                await _access.LoadPermitsAsync(request);
            }

            foreach (var item in queue)
            {
                await _access.ResolveIdentityAsync(item);
            }

            while (request.LoadPermits)
            {
                await _access.ReadIdentityAsync(request);
                break;
            }

            do
            {
                await _access.LoadPermitsAsync(request);
            }
            while (false);
        }

        public async Task ConcurrentForm(PassengerRequest request)
        {
            var started = Task.WhenAll(_access.ResolveIdentityAsync(request), _access.ReadIdentityAsync(request));
            await started;

            Task<PassengerIdentity> held = _access.ResolveIdentityAsync(request);
            await Task.WhenAny(held);

            _ = _access.LoadPermitsAsync(request);
        }

        public void CallbackForm(PassengerRequest request)
        {
            RunLater(() => _access.LoadPermitsAsync(request));
            Action<PassengerRequest> handler = (value) => _access.ResolveIdentityAsync(value);
        }

        public async Task NestedForms(PassengerRequest request, bool permit)
        {
            if (permit)
            {
                foreach (var item in new[] { request })
                {
                    if (item.LoadPermits)
                        await _access.LoadPermitsAsync(item);
                    else
                        await _access.ReadIdentityAsync(item);
                }

                try
                {
                    if (permit)
                        await _access.ResolveIdentityAsync(request);
                }
                catch (Exception)
                {
                    await _access.ReadIdentityAsync(request);
                }
            }
        }

        public async Task JoinLater(PassengerRequest request)
        {
            var pending = _access.ResolveIdentityAsync(request);
            await _access.LoadPermitsAsync(request);
            await pending;
            await _access.ReadIdentityAsync(request);
        }

        public async Task GuardedAwait(PassengerRequest request, bool permit)
        {
            var pending = _access.ResolveIdentityAsync(request);
            if (permit)
            {
                await pending;
            }

            await _access.ReadIdentityAsync(request);
        }

        public async Task LoopJoin(PassengerRequest request, IReadOnlyList<PassengerRequest> queue)
        {
            foreach (var item in queue)
            {
                var pending = _access.ResolveIdentityAsync(item);
                await pending;
            }

            await _access.LoadPermitsAsync(request);
        }

        public async Task GuardedAll(PassengerRequest request, bool permit)
        {
            if (permit)
            {
                await Task.WhenAll(_access.ResolveIdentityAsync(request), _access.ReadIdentityAsync(request));
            }

            await _access.LoadPermitsAsync(request);
        }

        public async Task TryJoin(PassengerRequest request, bool permit)
        {
            var pending = _access.ResolveIdentityAsync(request);
            try
            {
                await pending;
            }
            catch (Exception)
            {
                await _access.ReadIdentityAsync(request);
            }
            finally
            {
                await _access.LoadPermitsAsync(request);
            }
        }

        public void CallbackJoin(PassengerRequest request)
        {
            var pending = _access.ResolveIdentityAsync(request);
            RunLater(async () => await pending);
        }

        public async Task PreDeclaredJoin(PassengerRequest request, bool permit)
        {
            Task<PassengerIdentity> pending;
            if (permit)
            {
                pending = _access.ResolveIdentityAsync(request);
            }
            else
            {
                pending = _access.ReadIdentityAsync(request);
            }
            await pending;
        }

        public void PreDeclaredLaunch(PassengerRequest request)
        {
            Task<PassengerIdentity> started;
            started = _access.ResolveIdentityAsync(request);
        }

        public async Task CollectedJoin(PassengerRequest request)
        {
            var pending = new List<Task>();
            pending.Add(_access.ResolveIdentityAsync(request));
            pending.Add(_access.ReadIdentityAsync(request));
            await Task.WhenAll(pending);
        }

        public async Task ReplacedTask(PassengerRequest request)
        {
            Task<PassengerIdentity> pending;
            pending = _access.ResolveIdentityAsync(request);
            pending = _access.ReadIdentityAsync(request);
            await pending;
        }

        public async Task ReplacedInArm(PassengerRequest request, bool permit)
        {
            var pending = _access.ResolveIdentityAsync(request);
            if (permit)
            {
                pending = _access.ReadIdentityAsync(request);
            }
            await pending;
        }

        public async Task CollectedLaterTask(PassengerRequest request)
        {
            Task<PassengerIdentity> pending;
            var tasks = new List<Task>();
            pending = _access.ResolveIdentityAsync(request);
            tasks.Add(pending);
            await Task.WhenAll(tasks);
        }

        public async Task DelayedJoin(PassengerRequest request)
        {
            await Task.WhenAll(Task.Delay(10), _access.ResolveIdentityAsync(request));
        }

        private void RunLater(Action work)
        {
            work();
        }
    }
}
