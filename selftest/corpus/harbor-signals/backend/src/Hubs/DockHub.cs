using System;
using System.Threading.Tasks;
using Harbor.Signals.Services;
using Microsoft.AspNetCore.SignalR;

namespace Harbor.Signals.Hubs
{
    public abstract class DockHubBase : Hub
    {
        private readonly ILamp _lamp;

        protected DockHubBase(ILamp lamp)
        {
            _lamp = lamp;
        }

        public Task Ping()
        {
            return _lamp.Flash();
        }
    }

    public class DockHub : DockHubBase
    {
        private readonly IBerthLedger _ledger;

        public DockHub(ILamp lamp, IBerthLedger ledger) : base(lamp)
        {
            _ledger = ledger;
        }

        public async Task Moor(string berth)
        {
            await _ledger.Moor(berth);
        }

        public override Task OnConnectedAsync()
        {
            return _ledger.Greet();
        }

        public override Task OnDisconnectedAsync(Exception reason)
        {
            return _ledger.Farewell();
        }

        public static string Banner()
        {
            return "dock";
        }

        private Task Sweep()
        {
            return _ledger.Sweep();
        }
    }
}
