using System.Threading.Tasks;
using Bakery.Api.Models;

namespace Bakery.Api.Steps
{
    public interface IGlazeStep
    {
        Task ProcessAsync(Glaze glaze);
    }

    public class ZestStep : IGlazeStep
    {
        public Task ProcessAsync(Glaze glaze)
        {
            if (glaze.Flavour == "bitter") glaze.Valid = false;
            return Task.CompletedTask;
        }
    }

    public class AlmondStep : IGlazeStep
    {
        public Task ProcessAsync(Glaze glaze)
        {
            if (glaze.Flavour == "nut-free") glaze.Valid = false;
            return Task.CompletedTask;
        }
    }

    public interface ISprinkleStep
    {
        Task ProcessAsync(Glaze glaze);
    }

    public class WalnutStep : ISprinkleStep
    {
        public Task ProcessAsync(Glaze glaze)
        {
            if (glaze.Flavour == "plain") glaze.Valid = false;
            return Task.CompletedTask;
        }
    }

    public class CocoaStep : ISprinkleStep
    {
        public Task ProcessAsync(Glaze glaze)
        {
            if (glaze.Flavour == "vanilla") glaze.Valid = false;
            return Task.CompletedTask;
        }
    }

    public interface ICrumbStep
    {
        Task ProcessAsync(Glaze glaze);
    }

    public class ButterCrumbStep : ICrumbStep
    {
        public Task ProcessAsync(Glaze glaze)
        {
            if (glaze.Flavour == "vegan") glaze.Valid = false;
            return Task.CompletedTask;
        }
    }

    public class OatCrumbStep : ICrumbStep
    {
        public Task ProcessAsync(Glaze glaze)
        {
            if (glaze.Flavour == "gluten-free") glaze.Valid = false;
            return Task.CompletedTask;
        }
    }

    public interface IFrostingStep
    {
        Task ProcessAsync(Glaze glaze);
    }

    public class VanillaFrostingStep : IFrostingStep
    {
        public Task ProcessAsync(Glaze glaze)
        {
            if (glaze.Flavour == "sour") glaze.Valid = false;
            return Task.CompletedTask;
        }
    }

    public interface IFillStep
    {
        Task ProcessAsync(FillOrder order);
    }

    public interface ITopStep
    {
        Task ProcessAsync(TopOrder order);
    }

    public class GlazeAndFillStep : IFillStep, ITopStep
    {
        public Task ProcessAsync(FillOrder order)
        {
            if (order.Flavour == "empty") order.Valid = false;
            return Task.CompletedTask;
        }

        public Task ProcessAsync(TopOrder order)
        {
            if (order.Flavour == "cracked") throw new CrustCrackedException();
            return Task.CompletedTask;
        }
    }

    public class PlainFillStep : IFillStep
    {
        public Task ProcessAsync(FillOrder order)
        {
            return Task.CompletedTask;
        }
    }
}
