using System.Threading.Tasks;
using Bakery.Api.Models;

namespace Bakery.Api.Steps
{
    public interface ILayerStep
    {
        Task ProcessAsync(Order order);
    }

    public class CakeLayer01Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "01";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer02Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "02";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer03Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "03";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer04Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "04";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer05Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "05";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer06Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "06";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer07Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "07";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer08Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "08";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer09Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "09";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer10Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "10";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer11Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "11";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer12Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "12";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer13Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "13";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer14Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "14";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer15Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "15";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer16Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            order.Ticket = order.Ticket + "16";
            return Task.CompletedTask;
        }
    }

    public class CakeLayer17Step : ILayerStep
    {
        public Task ProcessAsync(Order order)
        {
            if (order.Sugar > order.Flour) order.Valid = false;
            return Task.CompletedTask;
        }
    }
}
