using System.Threading.Tasks;
using Akka.Actor;
using Harbor.Signals.Services;

namespace Harbor.Signals.Actors
{
    public class TideRose
    {
        public int Level { get; set; }
    }

    public class TideFell
    {
        public int Level { get; set; }
    }

    public class TideActor : ReceiveActor
    {
        private readonly ITideGauge _gauge;

        public TideActor(ITideGauge gauge)
        {
            _gauge = gauge;
            Receive<TideRose>(OnRose);
            ReceiveAsync<TideFell>(async message =>
            {
                await _gauge.Lower(message.Level);
            });
        }

        private void OnRose(TideRose message)
        {
            _gauge.Raise(message.Level);
        }
    }
}
