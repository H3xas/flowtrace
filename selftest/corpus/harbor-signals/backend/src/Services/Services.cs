using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;

namespace Harbor.Signals.Services
{
    public interface ILamp { Task Flash(); }
    public interface IBerthLedger { Task Moor(string berth); Task Greet(); Task Farewell(); Task Sweep(); }
    public interface ITideGauge { Task Lower(int level); void Raise(int level); }
    public interface IManifestLog { Task Write(string id); }
    public interface ISignalWire { Task Forward(string payload); }

    public class Lamp : ILamp
    {
        public Task Flash() { return Task.CompletedTask; }
    }

    public class BerthLedger : IBerthLedger
    {
        public Task Moor(string berth) { return Task.CompletedTask; }
        public Task Greet() { return Task.CompletedTask; }
        public Task Farewell() { return Task.CompletedTask; }
        public Task Sweep() { return Task.CompletedTask; }
    }

    public class TideGauge : ITideGauge
    {
        public Task Lower(int level) { return Task.CompletedTask; }
        public void Raise(int level) { }
    }

    public class ManifestLog : IManifestLog
    {
        public Task Write(string id) { return Task.CompletedTask; }
    }

    public class SignalWire : ISignalWire
    {
        public Task Forward(string payload) { return Task.CompletedTask; }
    }

    public static class Registrations
    {
        public static void Add(IServiceCollection services)
        {
            services.AddSingleton<ILamp, Lamp>();
            services.AddSingleton<IBerthLedger, BerthLedger>();
            services.AddSingleton<ITideGauge, TideGauge>();
            services.AddSingleton<IManifestLog, ManifestLog>();
            services.AddSingleton<ISignalWire, SignalWire>();
        }
    }
}
